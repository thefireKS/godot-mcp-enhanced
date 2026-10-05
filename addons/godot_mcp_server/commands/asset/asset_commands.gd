@tool
extends Node

# T6: asset 命令编排层。5 个 handle_* 调 AssetPlacer + PathGenerator + 编辑器 UndoRedo + PackedScene。
# 错误码：NO_ACTIVE_SCENE / PARENT_NOT_FOUND / NOTHING_TO_UNDO / NOT_ASSET_TOP / INVALID_PATH / RESOURCE_SAVE_FAILED
# 以及工厂/放置层透传的 UNSUPPORTED_SHAPE / INVALID_PARAMS / BATCH_LIMIT_EXCEEDED。

const AssetFactory = preload("asset_factory.gd")
const CustomMeshes = preload("custom_meshes.gd")
const MaterialPresets = preload("material_presets.gd")
const PathGenerator = preload("path_generator.gd")
const AssetPlacer = preload("asset_placer.gd")
const CommandHelpers = preload("../command_helpers.gd")

var _plugin: EditorPlugin
var _undo_manager: Node

func setup(plugin: EditorPlugin, undo_manager: Node) -> void:
	_plugin = plugin
	_undo_manager = undo_manager

# T1 Minor 收尾：与兄弟模块（sync/recording/particle/nav/ui/animtree_commands）对齐统一 cleanup 接口。
# 本模块无信号/定时器，释放 _plugin/_undo_manager 引用助 GC。
func cleanup() -> void:
	_plugin = null
	_undo_manager = null

# I-06: null-safe EditorInterface 访问器（与 node_commands.gd:23 一致）
func _get_ei() -> EditorInterface:
	if _plugin == null:
		push_error("[MCP] EditorPlugin not available")
		return null
	return _plugin.get_editor_interface()

# null-safe 场景根获取（无打开场景 → null）
func _get_root() -> Node:
	var ei := _get_ei()
	if ei == null:
		return null
	return ei.get_edited_scene_root()


# CMP-16-A (2026-08-08): param docs metadata。
func get_command_docs() -> Dictionary:
	return {
		"asset_create": {
			"description": "Place a single asset (primitive/custom shape) node in the scene.",
			"params": [
				CommandHelpers.doc_param("shape", "String", true, "Asset shape name"),
				CommandHelpers.doc_param("params", "Dictionary", false, "Shape-specific parameters, default {}"),
				CommandHelpers.doc_param("material", "JSON", false, "Material, default null"),
				CommandHelpers.doc_param("name", "String", false, "Node name, default empty"),
				CommandHelpers.doc_param("parent", "String", false, "Parent node path, empty = scene root"),
			],
		},
		"asset_path": {
			"description": "Place assets in bulk along sampled path points.",
			"params": [
				CommandHelpers.doc_param("path", "Array", false, "Sample points array; it or path_node must be valid, fewer than 2 points is an error"),
				CommandHelpers.doc_param("path_node", "String", false, "Reference path node used to resolve sample points"),
				CommandHelpers.doc_param("shape", "String", true, "Asset shape name"),
				CommandHelpers.doc_param("params", "Dictionary", false, "Shape-specific parameters"),
				CommandHelpers.doc_param("material", "JSON", false, "Material"),
				CommandHelpers.doc_param("mode", "String", false, "Layout mode, default discrete"),
				CommandHelpers.doc_param("spacing", "float", false, "Spacing, default 1.0"),
				CommandHelpers.doc_param("count", "int", false, "Count limit, default 0"),
				CommandHelpers.doc_param("align", "String", false, "Orientation mode, default path"),
				CommandHelpers.doc_param("align_vertices", "bool", false, "Align to vertices, default false"),
			],
		},
		"asset_batch": {
			"description": "Place several assets in bulk (same structure as asset_create).",
			"params": [
				CommandHelpers.doc_param("items", "Array", true, "Array of definitions, each with the shape/params/material/name/parent structure of asset_create"),
			],
		},
		"asset_undo": {
			"description": "Pop an asset-type action off the top of the global UndoRedo stack.",
			"params": [],
		},
		"asset_save": {
			"description": "Pack a node and save it as a .tscn resource.",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "Path of the node to pack and save"),
				CommandHelpers.doc_param("resource_path", "String", true, "Output .tscn path, needs the res:// prefix and no .. traversal"),
			],
		},
	}


# create：单件放置。无场景 → NO_ACTIVE_SCENE（区别于工厂层的 INVALID_PARAMS root=null）
func handle_create(params: Dictionary, request_id: int) -> Dictionary:
	var ei := _get_ei()
	if ei == null:
		return {"error": {"code": "NO_ACTIVE_SCENE", "message": "EditorInterface unavailable"}}
	var root := ei.get_edited_scene_root()
	if root == null:
		return {"error": {"code": "NO_ACTIVE_SCENE", "message": "no active scene"}}
	return AssetPlacer.place_one(root, _undo_manager,
		params.get("shape", ""), params.get("params", {}),
		params.get("material", null), params.get("name", ""),
		params.get("parent", ""), request_id)

# path：沿路径阵列。先解析采样点（空 → PARENT_NOT_FOUND），再 place_path
func handle_path(params: Dictionary, request_id: int) -> Dictionary:
	var root := _get_root()
	if root == null:
		return {"error": {"code": "NO_ACTIVE_SCENE", "message": "no active scene"}}
	var points := PathGenerator.resolve_points(root, params.get("path", []), params.get("path_node", ""))
	if points.is_empty():
		return {"error": {"code": "PARENT_NOT_FOUND", "message": "path_node invalid or path has fewer than 2 points"}}
	return AssetPlacer.place_path(root, _undo_manager, params.get("shape", ""),
		params.get("params", {}), params.get("material", null), points,
		params.get("mode", "discrete"), params.get("spacing", 1.0), params.get("count", 0),
		params.get("align", "path"), params.get("align_vertices", false), request_id)

# batch：多件原子放置（预校验原子，任一失败零节点落地）
func handle_batch(params: Dictionary, request_id: int) -> Dictionary:
	var root := _get_root()
	if root == null:
		return {"error": {"code": "NO_ACTIVE_SCENE", "message": "no active scene"}}
	return AssetPlacer.place_batch(root, _undo_manager, params.get("items", []), request_id)

# undo：弹 Godot 全局 UndoRedo 栈顶 asset 类 action。P1 修复: 校验栈顶 name 是
# asset_create_/asset_batch_(create_action_mixed 已用 request_id 标记, label 形如
# "MCP: asset_create_<id>"), 才 undo —— 避免多 peer/手动编辑场景下误撤栈顶非 asset
# 操作(MAX_PEERS=5 时 peer A 建 asset 后 peer B 改属性, 旧逻辑 A 的 undo 会撤 B 的)。
# 非 asset 栈顶 → NOT_ASSET_TOP, AI 须先处理栈顶或用编辑器 undo。Godot UndoRedo 是
# 全局单例, 无法 per-peer 隔离; 此校验把误撤范围从"任意栈顶"收窄到"asset 类栈顶"。
func handle_undo(params: Dictionary, request_id: int) -> Dictionary:
	# EditorUndoRedoManager 是 history 管理器(非 UndoRedo 子类), 无 get_action_name/undo。
	# 取当前场景 history 的 UndoRedo 再查栈顶 + undo(实测 2026-07-11: 原 get_action_name
	# 在 EditorUndoRedoManager 抛 SCRIPT ERROR 致 handle_undo 中断 → MCP 30s timeout;
	# 根因非 _process 重入 H1, 是 API 误用 EditorUndoRedoManager ≠ UndoRedo)。
	var root := _get_root()
	if root == null:
		return {"error": {"code": "NO_ACTIVE_SCENE", "message": "no active scene"}}
	# 2026-08-07 审查 P1 修复：_get_root() 通过 _get_ei() 间接守 _plugin==null，但
	# _get_root 返回后到 :89 之间 _plugin 可能被 cleanup/场景切换置 null（竞态）→
	# null.get_undo_redo() 抛 SCRIPT ERROR → MCP 30s 超时。显式守 _plugin + eur。
	if _plugin == null:
		return {"error": {"code": "NO_PLUGIN", "message": "EditorPlugin unavailable (cleanup or scene switch)"}}
	var eur := _plugin.get_undo_redo()
	if eur == null:
		return {"error": {"code": "NO_UNDO_REDO", "message": "EditorUndoRedoManager unavailable"}}
	var hid: int = eur.get_object_history_id(root)
	var ur: UndoRedo = eur.get_history_undo_redo(hid)
	var top: String = ur.get_current_action_name()
	# get_current_action_name() == "" 表示栈空（无 action 可 undo）
	if top == "":
		return {"error": {"code": "NOTHING_TO_UNDO", "message": "undo stack empty"}}
	# P1: 仅撤 asset 类栈顶, 防误撤其他 peer / 手动编辑的非 asset 操作
	if not (top.begins_with("MCP: asset_create_") or top.begins_with("MCP: asset_batch_")):
		return {"error": {"code": "NOT_ASSET_TOP", "message": "Top of the stack is not an asset operation: %s — asset_undo only undoes asset actions; deal with the top of the stack first or use the editor's undo" % top}}
	ur.undo()
	return {"result": {"undone": true, "action": top}}

# save：节点树 → .tscn。GD 侧 res:// + has_path_traversal 复核；TS 侧 realpathSync 在 Task 8
func handle_save(params: Dictionary, request_id: int) -> Dictionary:
	var root := _get_root()
	if root == null:
		return {"error": {"code": "NO_ACTIVE_SCENE", "message": "no active scene"}}
	var node := root.get_node_or_null(params.get("node_path", ""))
	if node == null:
		return {"error": {"code": "PARENT_NOT_FOUND", "message": "node_path: %s" % params.get("node_path", "")}}
	var res_path: String = params.get("resource_path", "")
	# 路径白名单：必须 res:// 前缀且无 .. 遍历段（防御深度，与 node_commands/ui_commands 对齐）
	if not res_path.begins_with("res://") or CommandHelpers.has_path_traversal(res_path):
		return {"error": {"code": "INVALID_PATH", "message": "resource_path must be res:// without traversal"}}
	var pkg := PackedScene.new()
	var err := pkg.pack(node)
	if err != OK:
		return {"error": {"code": "RESOURCE_SAVE_FAILED", "message": "pack failed: %d" % err}}
	# 确保目标目录存在（res:// 下子目录可能未建）
	DirAccess.make_dir_recursive_absolute(res_path.get_base_dir())
	err = CommandHelpers._save_atomic(pkg, res_path)
	if err != OK:
		return {"error": {"code": "RESOURCE_SAVE_FAILED", "message": "save failed: %d" % err}}
	return {"result": {"resource_path": res_path}}
