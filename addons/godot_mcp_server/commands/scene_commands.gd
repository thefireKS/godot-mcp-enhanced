extends Node

var _undo_manager: Node
var _editor_guards: Node
var _plugin: EditorPlugin

func setup(plugin: EditorPlugin, undo_manager: Node, editor_guards: Node) -> void:
	_undo_manager = undo_manager
	_editor_guards = editor_guards
	_plugin = plugin

# I-06: null-safe EditorInterface accessor
# 4.7: EditorInterface 不再作为 Engine singleton 注册,改用 EditorPlugin.get_editor_interface()。
func _get_ei() -> EditorInterface:
	if _plugin == null:
		push_error("[MCP] EditorPlugin not available")
		return null
	return _plugin.get_editor_interface()


# C-1 / IMP-2-CONSISTENCY: 段级 .. 阻断复用 CommandHelpers.has_path_traversal(单一实现,与 ui_commands 对齐)
func _has_path_traversal(p: String) -> bool:
	return CommandHelpers.has_path_traversal(p)


# CMP-16-A (2026-08-08): param docs metadata。
func get_command_docs() -> Dictionary:
	return {
		"open_scene": {
			"description": "Open a scene in the editor.",
			"params": [
				CommandHelpers.doc_param("scene_path", "String", true, "Scene resource path, needs the res:// prefix and no .. traversal"),
			],
		},
		"save_scene": {
			"description": "Save the current scene; an empty path uses the scene's bound scene_file_path.",
			"params": [
				CommandHelpers.doc_param("path", "String", false, "Save path; empty uses the scene's bound scene_file_path"),
			],
		},
		"instance_scene": {
			"description": "Instance a PackedScene and attach it to the current scene tree.",
			"params": [
				CommandHelpers.doc_param("scene_path", "String", true, "Current scene path"),
				CommandHelpers.doc_param("instance_path", "String", true, "PackedScene resource path to instance, must be res://"),
				CommandHelpers.doc_param("parent_node_path", "String", false, "Parent node path, empty = scene root"),
				CommandHelpers.doc_param("node_name", "String", false, "Instance node name; empty keeps the original root name"),
				CommandHelpers.doc_param("properties", "Dictionary", false, "Instance property key/values, through coerce_property_value"),
			],
		},
		"set_instance_property": {
			"description": "Change a single property of an instanced node.",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "Target instance node path; can't be the scene root"),
				CommandHelpers.doc_param("property", "String", true, "Property name"),
				CommandHelpers.doc_param("value", "JSON", true, "Property value, through coerce_property_value"),
			],
		},
	}


func handle_open_scene(params: Dictionary) -> Dictionary:
	var path: String = params.get("scene_path", "")
	if path.is_empty():
		return {"error": {"code": -32004, "message": "scene_path is required"}}
	if not path.begins_with("res://"):
		return {"error": {"code": -32004, "message": "scene_path must start with res://"}}
	if _has_path_traversal(path):
		return {"error": {"code": -32004, "message": "scene_path must not contain '..' traversal: " + path}}
	var ei := _get_ei()
	if ei == null:
		return {"error": {"code": -32000, "message": "EditorInterface not available"}}
	ei.open_scene_from_path(path)
	return {"result": {"status": "opened", "path": path}}


func handle_save_scene(params: Dictionary) -> Dictionary:
	var save_path: String = params.get("path", "")
	var ei := _get_ei()
	if ei == null:
		return {"error": {"code": -32000, "message": "EditorInterface not available"}}
	var root = ei.get_edited_scene_root()

	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open"}}

	if save_path.is_empty():
		save_path = root.scene_file_path
	if save_path.is_empty():
		return {"error": {"code": -32004, "message": "No save path and scene has no file path"}}

	# 守卫：不允许保存非活跃的已打开场景
	if _editor_guards != null:
		var guard = _editor_guards.guard_save_inactive_open_scene(save_path)
		if not guard.is_empty():
			return guard

	# 守卫：如果保存到不同路径，确保目标不是已打开的其他场景
	var normalized: String = _normalize_project_path(save_path)
	if _editor_guards != null and not normalized.is_empty():
		if root.scene_file_path.is_empty() or _normalize_project_path(root.scene_file_path) != normalized:
			var offline_guard = _editor_guards.guard_offline_scene_save(normalized)
			if not offline_guard.is_empty():
				return offline_guard

	# 使用 EditorInterface 保存（保留 undo 历史）
	var err: int
	var save_method: String
	if root.scene_file_path.is_empty() or _normalize_project_path(root.scene_file_path) != normalized:
		ei.save_scene_as(normalized, false)
		# IMPORTANT-1: save_scene_as 是 void 同步调用，保存后验证文件存在
		var abs_path: String = ProjectSettings.globalize_path(normalized)
		err = OK if FileAccess.file_exists(abs_path) else FAILED
		save_method = "save_scene_as"
	else:
		err = ei.save_scene()
		save_method = "save_scene"

	if err != OK:
		# GD-R8 (2026-08-08): save_scene_as 是 void 调用只能靠 file_exists 推断,error_string(FAILED) 无信息。
		# save_scene 返真实 error code 可用 error_string。区分两条路径的诊断。
		if save_method == "save_scene_as":
			return {"error": {"code": -32000, "message": "Save failed via save_scene_as: file does not exist after save (possible permission/path/scene-error — check editor log for details). Target: %s" % normalized}}
		return {"error": {"code": -32000, "message": "Save failed via %s: %s" % [save_method, error_string(err)]}}

	return {"result": {"status": "saved", "path": normalized, "method": save_method}}


func handle_instance_scene(params: Dictionary) -> Dictionary:
	var scene_path: String = params.get("scene_path", "")
	var instance_path: String = params.get("instance_path", "")
	var parent_path: String = params.get("parent_node_path", "")
	var node_name: String = params.get("node_name", "")
	var properties: Dictionary = params.get("properties", {})

	if scene_path.is_empty() or instance_path.is_empty():
		return {"error": {"code": -32004, "message": "scene_path and instance_path required"}}
	if not instance_path.begins_with("res://"):
		return {"error": {"code": -32004, "message": "instance_path must start with res://"}}
	if _has_path_traversal(instance_path):
		return {"error": {"code": -32004, "message": "instance_path must not contain '..' traversal: " + instance_path}}
	if scene_path == instance_path:
		return {"error": {"code": -32004, "message": "CIRCULAR_REFERENCE"}}

	var instance_res = load(instance_path)
	if instance_res == null:
		return {"error": {"code": -32000, "message": "INSTANCE_LOAD_FAILED: " + instance_path}}
	if not (instance_res is PackedScene):
		return {"error": {"code": -32000, "message": "NOT_A_PACKED_SCENE: " + instance_path}}

	var instance = instance_res.instantiate()
	if not node_name.is_empty():
		instance.name = node_name

	# P2-4（设计固化，不改逻辑）：properties 在 create_action_mixed 之外直接 instance.set，
	# 与 node_commands.gd:74 add_node 把 properties 放进 do_ops 不同。功能不坏——节点由
	# reference op 持有存活，undo/redo 周期内 remove_child 不清除节点属性（节点存活故 properties 不丢）。
	# 已过 coerce_property_value 防类型 silent no-op。若未来节点生命周期变化（reference op
	# 不再持有存活），需把 properties 改走 do_ops 对齐 add_node。
	for key in properties:
		if key.begins_with("_"):
			continue
		if not key is String:
			continue
		if ":" in key or "/" in key:
			continue
		var val = properties[key]
		if val is Object:
			continue
		var r := CommandHelpers.coerce_property_value(instance, key, val)
		if r["ok"]:
			instance.set(key, r["value"])

	var ei := _get_ei()
	if ei == null:
		instance.queue_free()
		return {"error": {"code": -32000, "message": "EditorInterface not available"}}
	var root = ei.get_edited_scene_root()
	if root == null:
		instance.queue_free()
		return {"error": {"code": -32003, "message": "No edited scene"}}
	var parent = CommandHelpers.find_node(root, parent_path)
	if parent == null:
		parent = root

	# UndoRedo: instance_scene 加入场景树
	if _undo_manager != null:
		_undo_manager.create_action_mixed("Instance Scene",
			[
				{"type": "method", "target": parent, "method": "add_child", "args": [instance]},
				{"type": "method", "target": instance, "method": "set_owner", "args": [root]},
				{"type": "reference", "value": instance}
			],
			[
				{"type": "method", "target": parent, "method": "remove_child", "args": [instance]}
			]
		)
	else:
		parent.add_child(instance)
		instance.owner = root

	return {"result": {"node_name": str(instance.name), "instance_of": instance_path}}


func handle_set_instance_property(params: Dictionary, request_id: int = 0) -> Dictionary:
	var node_path: String = params.get("node_path", "")
	var prop_name: String = params.get("property", "")
	var prop_value = params.get("value")

	if node_path.is_empty() or prop_name.is_empty():
		return {"error": {"code": -32004, "message": "node_path and property required"}}

	var ei := _get_ei()
	if ei == null:
		return {"error": {"code": -32000, "message": "EditorInterface not available"}}
	var root = ei.get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No edited scene"}}
	var target = CommandHelpers.find_node(root, node_path)
	if target == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}

	# 2026-08-06 审查 P1 修复：原判据 `target == root or target.owner != root` 误拒合法嵌套
	# instance 子节点（PackedScene instantiate 时 set_owner 只设根 instance，其子节点 owner
	# 可能是中间 instance 根而非场景 root）。改为只拒场景根自身（root 无 instance 可改）。
	# 与 handle_edit_node（node_commands.gd）对齐——后者无此校验，工具间不应不一致。
	if target == root:
		return {"error": {"code": -32004, "message": "NODE_NOT_INSTANCE"}}

	if prop_name.begins_with("_"):
		return {"error": {"code": -32004, "message": "BLOCKED_PROPERTY: " + prop_name}}
	if ":" in prop_name or "/" in prop_name:
		return {"error": {"code": -32004, "message": "BLOCKED_SUBPROPERTY: " + prop_name}}
	if prop_name.is_empty() or (not (prop_name[0] == "_" or (prop_name[0] >= "a" and prop_name[0] <= "z") or (prop_name[0] >= "A" and prop_name[0] <= "Z"))):
		return {"error": {"code": -32004, "message": "INVALID_PROPERTY_NAME: " + prop_name}}
	if prop_value is Object:
		return {"error": {"code": -32004, "message": "OBJECT_VALUES_NOT_ALLOWED"}}
	var r := CommandHelpers.coerce_property_value(target, prop_name, prop_value)
	if not r["ok"]:
		return {"error": {"code": -32004, "message": "PROPERTY_TYPE_MISMATCH: " + prop_name + " — " + String(r["error"])}}
	prop_value = r["value"]

	# UndoRedo: 记录旧值（C12: 只读属性跳过 undo，避免回放 set(prop,null) 错误赋值）
	if _undo_manager != null:
		var undo_ops: Array = []
		# C12: PROPERTY_USAGE_READ_ONLY 属性的 get 返当前值但 set 无意义；
		# 不存在属性 get 返 null，记 undo 会错误赋值。只读跳过 undo，可写仍记（null 合法旧值）。
		var usage: Variant = CommandHelpers._get_property_usage(target, prop_name)
		if usage == null or (int(usage) & PROPERTY_USAGE_READ_ONLY) == 0:
			var old_value: Variant = target.get(prop_name)
			undo_ops.append({"type": "property", "target": target, "property": prop_name, "value": old_value})
		_undo_manager.create_action_mixed("Set Instance Property (req:%d)" % request_id,
			[
				{"type": "property", "target": target, "property": prop_name, "value": prop_value}
			],
			undo_ops
		)
	else:
		target.set(prop_name, prop_value)
	return {"result": {"node": str(target.name), "property": prop_name}}


func _normalize_project_path(path: String) -> String:
	# Issue 5: 复用 editor_guards.normalize_path
	if _editor_guards != null:
		return _editor_guards.normalize_path(path)
	if path.is_empty():
		return ""
	if path.begins_with("res://") or path.begins_with("user://"):
		return path.simplify_path()
	return ProjectSettings.localize_path(path).simplify_path()
