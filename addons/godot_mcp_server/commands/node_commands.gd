extends Node

var _undo_manager: Node
var _plugin: EditorPlugin

const ALLOWED_NODE_TYPES: Array = [
	"Node3D", "MeshInstance3D", "StaticBody3D", "RigidBody3D",
	"CharacterBody3D", "Camera3D", "Light3D", "DirectionalLight3D",
	"OmniLight3D", "SpotLight3D", "CollisionShape3D", "RayCast3D",
	"Area3D", "Marker3D", "PathFollow3D", "VisibleOnScreenNotifier3D",
	"Node", "Node2D", "Sprite2D", "AnimatedSprite2D",
	"CollisionShape2D", "Area2D", "RigidBody2D", "CharacterBody2D",
	"AudioStreamPlayer", "AudioStreamPlayer2D", "AudioStreamPlayer3D",
	"AnimationPlayer", "AnimationTree", "Timer",
]

func setup(plugin: EditorPlugin, undo_manager: Node) -> void:
	_undo_manager = undo_manager
	_plugin = plugin

# I-06: null-safe EditorInterface accessor
# 4.7: EditorInterface 不再作为 Engine singleton 注册,改用 EditorPlugin.get_editor_interface()。
func _get_ei() -> EditorInterface:
	if _plugin == null:
		push_error("[MCP] EditorPlugin not available")
		return null
	return _plugin.get_editor_interface()


# CMP-16-A (2026-08-08): param docs metadata。
func get_command_docs() -> Dictionary:
	return {
		"add_node": {
			"description": "Add a new node to the scene tree (type must be whitelisted).",
			"params": [
				CommandHelpers.doc_param("node_type", "String", false, "Node type, must be in the ALLOWED_NODE_TYPES whitelist, default Node"),
				CommandHelpers.doc_param("node_name", "String", false, "Node name, must match ^[A-Za-z0-9_]+$, default NewNode"),
				CommandHelpers.doc_param("parent_node_path", "String", false, "Parent node path, empty = scene root"),
				CommandHelpers.doc_param("properties", "Dictionary", false, "Node property key/values, through coerce_property_value"),
			],
		},
		"remove_node": {
			"description": "Delete a node from the scene tree (the scene root can't be deleted).",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "Path of the node to delete; the scene root can't be deleted"),
			],
		},
		"edit_node": {
			"description": "Change node properties in bulk (per-property undo).",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "Target node path"),
				CommandHelpers.doc_param("properties", "Dictionary", true, "Property key/values, must be non-empty; per-property undo"),
			],
		},
		"batch_add_nodes": {
			"description": "Add nodes in bulk (max 100).",
			"params": [
				CommandHelpers.doc_param("nodes", "Array", true, "Node definitions, max 100, each with node_type/node_name/parent_node_path/properties"),
			],
		},
	}


func handle_add_node(params: Dictionary, request_id: int) -> Dictionary:
	var ei := _get_ei()
	if ei == null: return {"error": {"code": -32000, "message": "EditorInterface not available"}}
	var root = ei.get_edited_scene_root()
	if not root:
		return {"error": {"code": -32003, "message": "No scene loaded"}}

	var node_type: String = params.get("node_type", "Node")
	var node_name: String = params.get("node_name", "NewNode")
	var parent_path: String = params.get("parent_node_path", "")

	# I-5: node_name 字符白名单(与 TS 端 addNode 的 ^[A-Za-z0-9_]+$ 对齐),防特殊字符/换行污染 .tscn 节点名属性。
	var _name_re := RegEx.create_from_string("^[A-Za-z0-9_]+$")
	if node_name.is_empty() or not _name_re.search(node_name):
		return {"error": {"code": -32004, "message": "Invalid node name: %s" % node_name}}

	if not _is_allowed_node_type(node_type):
		return {"error": {"code": -32004, "message": "Blocked node type: %s. For Control types (TextureRect/Button etc.) use the ui_create_control tool" % node_type}}

	var parent_node: Node = root
	if not parent_path.is_empty():
		# 范畴错误修正（D2 follow-up 2026-07-24）：节点路径用 find_node→get_node_or_null 解析，受 SceneTree
		# root 子树限制无法逃逸 fs；.. 是合法父引用（root/A/../B 等价 root/B）。撤 has_path_traversal 前置
		# （resource 范畴检查误用于 scene tree），对齐 memory nodepath-traversal-category-error + 批次 A A11 否决。
		# F1 (2026-07-20): 复用 CommandHelpers.find_node（识别 "root"/root_name/"root/" 前缀），
		# 对齐 handle_edit_node / handle_batch_add_nodes / headless godot_operations.gd:316。
		# 原 root.get_node_or_null 不识别 "root"（root 不是自己的子节点）→ editor 路由 add_node parent="root" 失效。
		parent_node = CommandHelpers.find_node(root, parent_path)
		if not parent_node:
			return {"error": {"code": -32002, "message": "Parent not found: %s" % parent_path}}

	var cls = ClassDB.instantiate(node_type)
	if not cls:
		return {"error": {"code": -32000, "message": "Cannot instantiate: %s" % node_type}}
	cls.name = node_name

	# properties coerce → prop_do_ops（undo 不需逐 property：remove_child 整节点 properties 随之消失）
	var properties: Dictionary = params.get("properties", {})
	var failed: Array = []
	var prop_do_ops: Array = []
	for key in properties:
		var r := CommandHelpers.coerce_property_value(cls, String(key), properties[key])
		if not r["ok"]:
			failed.append({"key": String(key), "error": String(r["error"])})
			continue
		prop_do_ops.append({"type": "method", "target": cls, "method": "set", "args": [String(key), r["value"]]})

	if _undo_manager != null:
		var do_ops: Array = [
			{"type": "method", "target": parent_node, "method": "add_child", "args": [cls]},
			{"type": "method", "target": cls, "method": "set_owner", "args": [root]},
		]
		do_ops.append_array(prop_do_ops)
		do_ops.append({"type": "reference", "value": cls})
		_undo_manager.create_action_mixed("Add Node %s (req:%d)" % [node_name, request_id], do_ops,
			[{"type": "method", "target": parent_node, "method": "remove_child", "args": [cls]}])
	else:
		parent_node.add_child(cls)
		cls.owner = root
		for op in prop_do_ops:
			op["target"].set(op["args"][0], op["args"][1])
	return {"result": {"node_path": str(cls.get_path()), "status": "created", "failed": failed}}


# editor 内存删除节点（UndoRedo，do=remove_child / undo=add_child+set_owner+reference）。
# 不 queue_free —— reference 让 UndoRedo 管理生命周期，undo 可恢复。
# 与 add_node 对称：scene 工具 remove_node 经 editor-method-map 走此处（不再 -32601 回退 headless 文件操作）。
func handle_remove_node(params: Dictionary, request_id: int) -> Dictionary:
	var ei := _get_ei()
	if ei == null:
		return {"error": {"code": -32000, "message": "EditorInterface not available"}}
	var root = ei.get_edited_scene_root()
	if not root:
		return {"error": {"code": -32003, "message": "No scene loaded"}}

	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		return {"error": {"code": -32004, "message": "node_path is required"}}

	# 健壮：get_node_or_null 从 root 起解析相对路径。兼容用户传完整场景路径
	# ("GameplayIsland/Props/Tree") 或相对根路径 ("Props/Tree")，strip 根名前缀。
	var root_name := str(root.name)
	if node_path == root_name or node_path == "/root/" + root_name:
		return {"error": {"code": -32002, "message": "Cannot remove scene root: %s" % node_path}}
	if node_path.begins_with(root_name + "/"):
		node_path = node_path.substr(root_name.length() + 1)

	var target: Node = root.get_node_or_null(node_path)
	if not target:
		return {"error": {"code": -32002, "message": "Node not found: %s" % node_path}}
	var parent_node: Node = target.get_parent()
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Node has no parent (orphan): %s" % node_path}}

	var owner_node: Node = target.owner
	var node_name: String = target.name
	var removed_path: String = str(target.get_path())

	if _undo_manager != null:
		_undo_manager.create_action_mixed("Remove Node %s (req:%d)" % [node_name, request_id],
			[
				{"type": "method", "target": parent_node, "method": "remove_child", "args": [target]}
			],
			[
				{"type": "method", "target": parent_node, "method": "add_child", "args": [target]},
				{"type": "method", "target": target, "method": "set_owner", "args": [owner_node if owner_node else root]},
				{"type": "reference", "value": target}
			]
		)
	else:
		parent_node.remove_child(target)
	return {"result": {"node_path": removed_path, "name": node_name, "status": "removed"}}


# editor 内存改节点属性（UndoRedo per-property undo：do=set new / undo=set old）。
# editor-method-map 登记 edit_node 后，editor 连接时 scene 工具 edit_node 路由到此处（不再 spawnGodot 改盘）。
# properties coerce 失败累计进返回值（非阻塞，对齐 headless edit_node）。节点找不到返 -32002。
# old_val 预读：node.get(key)；只读 property 预读 null 时 undo 会 set(key,null)。
# C12 已实现 PROPERTY_USAGE_READ_ONLY 检查（下方 _get_property_usage），只读属性跳过 undo 记录。
func handle_edit_node(params: Dictionary, request_id: int) -> Dictionary:
	var ei := _get_ei()
	if ei == null:
		return {"error": {"code": -32000, "message": "EditorInterface not available"}}
	var root = ei.get_edited_scene_root()
	if not root:
		return {"error": {"code": -32003, "message": "No scene loaded"}}
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		return {"error": {"code": -32004, "message": "node_path is required"}}
	var node: Node = CommandHelpers.find_node(root, node_path)
	if not node:
		return {"error": {"code": -32002, "message": "Node not found: %s" % node_path}}
	var properties: Dictionary = params.get("properties", {})
	if properties.is_empty():
		return {"error": {"code": -32004, "message": "properties is required (non-empty)"}}

	var do_ops: Array = []
	var undo_ops: Array = []
	var failed: Array = []
	for key in properties:
		var r := CommandHelpers.coerce_property_value(node, String(key), properties[key])
		if not r["ok"]:
			failed.append({"key": String(key), "error": String(r["error"])})
			continue
		var coerced: Variant = r["value"]
		# C12: 只读属性（PROPERTY_USAGE_READ_ONLY）set 无意义/可能拒；
		# 且 node.get(key) 对不存在的 property 返 null，记 undo 会致 undo 回放 set(key,null) 错误赋值。
		# 跳过只读属性的 undo（do 仍 set 尝试，undo 不回放只读 set，避免错误赋值）。
		# 可写但当前值 null 仍记 undo（null 是合法旧值）。
		var usage: Variant = CommandHelpers._get_property_usage(node, String(key))
		if usage == null or (int(usage) & PROPERTY_USAGE_READ_ONLY) == 0:
			var old_val: Variant = node.get(String(key))
			undo_ops.append({"type": "method", "target": node, "method": "set", "args": [String(key), old_val]})
		# op 显式 type:"method"（对齐 handle_add_node:66），method:"set" 经 undo_manager.gd:55 callv spread
		do_ops.append({"type": "method", "target": node, "method": "set", "args": [String(key), coerced]})

	if do_ops.is_empty():
		# 全 property coerce 失败：不注册 undo，返失败列表
		return {"result": {"node_path": str(node.get_path()), "updated": 0, "failed": failed}}

	if _undo_manager != null:
		_undo_manager.create_action_mixed("Edit Node %s (req:%d)" % [str(node.get_path()), request_id], do_ops, undo_ops)
	else:
		for op in do_ops:
			op["target"].set(op["args"][0], op["args"][1])
	return {"result": {"node_path": str(node.get_path()), "updated": do_ops.size(), "failed": failed}}


# editor 内存批量加节点（UndoRedo，do=add_child+set_owner+set properties / undo=remove_child 各节点）。
# 预校验全部 node → 任一失败返结构化错误，editor 内存零改。
# editor-method-map 登记后 editor 连接时 scene 工具 batch_add_nodes 路由到此处。
# 名字校验统一白名单 ^[A-Za-z0-9_]+$（对齐 handle_add_node:41，非 index.ts:323 黑名单）。
func handle_batch_add_nodes(params: Dictionary, request_id: int) -> Dictionary:
	var ei := _get_ei()
	if ei == null:
		return {"error": {"code": -32000, "message": "EditorInterface not available"}}
	var root = ei.get_edited_scene_root()
	if not root:
		return {"error": {"code": -32003, "message": "No scene loaded"}}
	var nodes: Array = params.get("nodes", [])
	if nodes.is_empty():
		return {"error": {"code": -32004, "message": "nodes must be a non-empty array"}}
	if nodes.size() > 100:
		return {"error": {"code": -32004, "message": "Too many nodes (%d). Maximum: 100" % nodes.size()}}

	var _name_re := RegEx.create_from_string("^[A-Za-z0-9_]+$")
	# P1-1(addons) 两阶段：先全预校验（name/type/parent，零 instantiate），全过后第二阶段
	# 才 ClassDB.instantiate + append。对齐 asset_placer.gd:64-90。
	# 原单循环 bug：instantiate(:229) 在校验循环内，下一轮 :223/:225/:228 early return 时，
	# 前几轮已 instantiate 的 cls 未 free → 孤儿 Node leak（C11 扫描在 create_action_mixed 后到不了）。
	# 第一阶段：全预校验，任一失败立即返错（零 instantiate 产物，无孤儿可 leak）
	var prechecked: Array = []
	for i in range(nodes.size()):
		var n: Dictionary = nodes[i]
		var node_type: String = String(n.get("node_type", "Node"))
		var node_name: String = String(n.get("node_name", "NewNode"))
		var parent_path: String = String(n.get("parent_node_path", ""))
		if node_name.is_empty() or not _name_re.search(node_name):
			return {"error": {"code": -32004, "message": "nodes[%d].node_name invalid: %s" % [i, node_name]}}
		if not _is_allowed_node_type(node_type):
			return {"error": {"code": -32004, "message": "nodes[%d].node_type blocked: %s. For Control types (TextureRect/Button etc.) use the ui_create_control tool" % [i, node_type]}}
		var parent_node: Node = root if parent_path.is_empty() else CommandHelpers.find_node(root, parent_path)
		if not parent_node:
			return {"error": {"code": -32002, "message": "nodes[%d].parent not found: %s" % [i, parent_path]}}
		prechecked.append({"node_type": node_type, "node_name": node_name, "parent": parent_node, "properties": n.get("properties", {})})
	# 第二阶段：全预校验通过，才 ClassDB.instantiate + append（此时无 early return，不会孤儿）
	var validated: Array = []
	for p in prechecked:
		var cls = ClassDB.instantiate(p["node_type"])
		if not cls:
			# instantiate 失败：前序已 instantiate 的 cls 需 free（防此处 return 孤儿）
			for v in validated:
				var prev_cls: Node = v["cls"]
				if prev_cls != null and is_instance_valid(prev_cls):
					prev_cls.free()
			return {"error": {"code": -32000, "message": "cannot instantiate: %s" % p["node_type"]}}
		cls.name = p["node_name"]
		validated.append({"cls": cls, "parent": p["parent"], "name": p["node_name"], "properties": p["properties"]})

	# 全过 → 批量 create_action_mixed
	var do_ops: Array = []
	var undo_ops: Array = []
	var failed: Array = []
	for v in validated:
		var cls: Node = v["cls"]
		var parent_node: Node = v["parent"]
		var props: Dictionary = v["properties"]
		do_ops.append({"type": "method", "target": parent_node, "method": "add_child", "args": [cls]})
		do_ops.append({"type": "method", "target": cls, "method": "set_owner", "args": [root]})
		for key in props:
			var r := CommandHelpers.coerce_property_value(cls, String(key), props[key])
			if not r["ok"]:
				failed.append({"node": String(v["name"]), "key": String(key), "error": String(r["error"])})
				continue
			do_ops.append({"type": "method", "target": cls, "method": "set", "args": [String(key), r["value"]]})
		do_ops.append({"type": "reference", "value": cls})
		undo_ops.append({"type": "method", "target": parent_node, "method": "remove_child", "args": [cls]})

	# C11: commit 中途失败（某 add_child/callv 在 undo_manager 内部 push_error 但 GDScript 无异常机制）
	# → 已预校验 instantiate 的 Node 孤儿 leak。
	# 原因：validated[i].cls 在 :233 ClassDB.instantiate 完成，commit 失败后无清理 → 孤儿 Node + 子 Resource leak。
	# GDScript 无 try/catch 异常语法（语言级限制），改 commit 后扫 validated：
	# 未入树的 cls（add_child 失败的孤儿）显式 free；已入树的（成功 add_child）由场景树 owner 管理生命周期。
	# is_instance_valid 守护：已被 undo_manager reference op 持有的 cls 不重复 free。
	if _undo_manager != null:
		_undo_manager.create_action_mixed("Batch Add %d Nodes (req:%d)" % [validated.size(), request_id], do_ops, undo_ops)
	else:
		for op in do_ops:
			if String(op.get("type", "method")) == "method":
				op["target"].callv(op["method"], op["args"])

	# 扫孤儿：commit 后任何未入树的 cls（add_child 失败的预 instantiate Node）立即 free 防 leak。
	# B5 (2026-08-11 审查): 同轮统计真实入树数——原返回 added: validated.size() 是乐观陈述,
	# C11 孤儿扫描 free 掉的 add_child 失败者也计入,极端场景(parent freed 致 add_child 失败)
	# added > 实际入树数 = 假成功。added 改基于 is_inside_tree() 真实计数。
	var added := 0
	for v in validated:
		var cls: Node = v["cls"]
		if cls != null and is_instance_valid(cls) and not cls.is_inside_tree():
			cls.free()
		elif cls != null and is_instance_valid(cls):
			added += 1

	return {"result": {"added": added, "failed": failed}}


func _is_allowed_node_type(node_type: String) -> bool:
	# I-4: 严格白名单——仅允许 ALLOWED_NODE_TYPES 精确匹配,不再用 is_parent_class 兜底。
	# 原兜底放行任意 Node 子类(含第三方 addon 的 class_name 脚本),实例化时触发其 _ready()/_init()
	# 执行任意 GDScript。需自定义类型请改用 execute_gdscript 或编辑器手动操作。
	return node_type in ALLOWED_NODE_TYPES
