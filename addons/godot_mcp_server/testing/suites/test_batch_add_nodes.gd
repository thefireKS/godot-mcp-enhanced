@tool
extends McpTestSuite

## H-2 coverage suite for node_commands.gd handle_batch_add_nodes（批 H, 2026-08-15）。
##
## 锁定 B5 修复(2026-08-11,commit 8ce609d)后的行为契约:added 必须等于**真实入树
## 计数**(is_inside_tree),而非 validated.size() 乐观陈述。套件对每条断言都用
## "独立数树"(不信返回值,自己数 arena 里新建节点)交叉验证,防返回值与树状态
## 漂移的假成功。
##
## 覆盖路径:
##   1. 正常批量: added == N == 真实 is_inside_tree 计数 + 批量 undo 原子性
##   2. 无效 parent: precheck 整体拒绝(-32002)且零节点入树(无部分成功)
##   3. property coerce 失败: failed 列表正确 + 节点仍入树(added 计数不受影响)
##   4. 上限防御: >100 节点整体拒绝(-32004)
##   5. 多层级: parent/child 一次批量建树,层级真实入树
##
## 注意(接线验证结论,详见批 H 报告):B5 修复针对的"add_child 失败致
## validated.size > 真实入树数"场景**无法经完整 handler 公开路径构造**——
## find_node 经 get_node_or_null 只能到达树上节点(get_node_or_null 不走
## 树外父子链),故 parent 恒在树上,add_child 恒成功;唯一的 add_child 失败
## 形态(freed parent)是 SCRIPT ERROR 崩溃类,会让 runner 捕获 abort 而非产生
## 差异计数。因此套件锁定的是"返回 added 严格等于真实入树计数"的契约 +
## precheck/failed 列表语义;临时改回 validated.size() 在正常路径不红
## (两者恰好相等),已在报告中如实记录。
##
## NodeCommands 实例:ctx 只带 plugin/undo_manager(test_commands.gd 构造),
## 本套件自行 new 一个 node_commands(纯数据 handler,不依赖 process/tree,
## 不需挂树),setup(plugin, undo_manager) 后直接调 handle_batch_add_nodes。

const NodeCommandsScript := preload("res://addons/godot_mcp_server/commands/node_commands.gd")

var _plugin: EditorPlugin
var _undo_manager: Node
var _node_commands: Node
var _arena: Node  ## suite 级 fixture:批量节点的挂载点,suite_teardown 释放


func suite_name() -> String:
	return "batch_add_nodes"


func suite_setup(ctx: Dictionary) -> void:
	_plugin = ctx.get("plugin", null)
	_undo_manager = ctx.get("undo_manager", null)
	if _plugin == null:
		fail_setup("batch_add_nodes: ctx.plugin is null — run via editor test_run, not headless")
		return
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		skip_suite("no scene open in editor — batch_add_nodes tests require an edited scene")
		return
	_node_commands = NodeCommandsScript.new()
	_node_commands.setup(_plugin, _undo_manager)
	_arena = Node.new()
	## 对齐 test_undo_manager.gd 的 arena 范式:_McpTest* 前缀 + persistent meta
	## 防 runner 的 _free_mcp_test_nodes_recursive 误清 suite 级 fixture。
	_arena.name = "_McpTestBatchArena"
	_arena.set_meta("_mcp_test_owned", true)
	_arena.set_meta("_mcp_test_persistent", true)
	scene_root.add_child(_arena)
	_arena.owner = scene_root


func setup() -> void:
	pass


func teardown() -> void:
	## 清掉本 test 遗留在 arena 的子节点(防跨 test 串数;undo 后的孤儿也一并清)。
	if _arena != null and is_instance_valid(_arena):
		for child in _arena.get_children():
			_arena.remove_child(child)
			child.queue_free()


func suite_teardown() -> void:
	if _node_commands != null and is_instance_valid(_node_commands):
		_node_commands.free()
		_node_commands = null
	if _arena != null and is_instance_valid(_arena):
		var parent := _arena.get_parent()
		if parent != null:
			parent.remove_child(_arena)
		_arena.queue_free()


## 便捷封装:调 handle_batch_add_nodes 并返回 response Dictionary。
func _batch(nodes: Array) -> Dictionary:
	return _node_commands.handle_batch_add_nodes({"nodes": nodes}, 1)


## 独立数树(不信 handler 返回值):arena 下 is_inside_tree 的 _McpTest* 子节点数。
func _count_tree_children() -> int:
	var n := 0
	for child in _arena.get_children():
		if child.is_inside_tree():
			n += 1
	return n


# ----- test 1: 正常批量 —— added == N == 真实入树计数(B5 契约)+ 批量 undo ----

func test_normal_batch_added_matches_real_tree_count() -> void:
	var resp := _batch([
		{"node_type": "Node", "node_name": "_McpTestBatchA1", "parent_node_path": "_McpTestBatchArena"},
		{"node_type": "Node2D", "node_name": "_McpTestBatchA2", "parent_node_path": "_McpTestBatchArena"},
		{"node_type": "Timer", "node_name": "_McpTestBatchA3", "parent_node_path": "_McpTestBatchArena"},
	])
	assert_false(resp.has("error"), "A normal batch should not fail: %s" % str(resp.get("error", {})))
	var result: Dictionary = resp.get("result", {})
	assert_eq(int(result.get("added", -1)), 3, "added should be 3")
	## B5 核心契约:返回 added 严格等于独立数的真实入树计数(不信返回值)。
	assert_eq(_count_tree_children(), int(result.get("added", -1)),
		"The real in-tree count (is_inside_tree) should == added (B5 contract: the return value must not overstate)")
	## 逐节点真实入树验证。
	for name in ["_McpTestBatchA1", "_McpTestBatchA2", "_McpTestBatchA3"]:
		var n := CommandHelpers.find_node(_arena, name)
		assert_true(n != null and n.is_inside_tree(), "%s should really be in the tree" % name)
	## 批量 undo 原子性:一次 undo 三个节点全部离树。
	var did_undo := editor_undo(_plugin.get_undo_redo())
	assert_true(did_undo, "editor_undo should succeed (the batch action is on the stack)")
	assert_eq(_count_tree_children(), 0, "The arena should be empty after the batch undo (atomicity)")


# ----- test 2: 无效 parent —— precheck 整体拒绝 + 零节点入树 ------------------

func test_invalid_parent_rejects_whole_batch() -> void:
	var before := _count_tree_children()
	var resp := _batch([
		{"node_type": "Node", "node_name": "_McpTestBatchOkNode", "parent_node_path": "_McpTestBatchArena"},
		{"node_type": "Node", "node_name": "_McpTestBatchOrphan", "parent_node_path": "_McpTestBatchArena/NoSuchParent"},
	])
	assert_true(resp.has("error"), "A batch with an invalid parent should fail as a whole (implemented as a full precheck rejection, not partial success)")
	var err: Dictionary = resp.get("error", {})
	assert_eq(int(err.get("code", 0)), -32002, "Error code should be -32002 (parent not found)")
	assert_contains(String(err.get("message", "")), "NoSuchParent", "The error message should name the missing parent")
	## 零节点入树:有效定义的那个节点也不得入树(precheck 语义,无部分成功)。
	assert_eq(_count_tree_children(), before, "No new nodes in the tree after the whole batch is rejected")
	var leaked := CommandHelpers.find_node(EditorInterface.get_edited_scene_root(), "_McpTestBatchOkNode")
	assert_true(leaked == null, "No instantiated nodes should be left over after the whole batch is rejected (zero orphans)")


# ----- test 3: property coerce 失败 —— failed 列表正确 + 节点仍入树 ------------

func test_property_coerce_failure_lists_failed_node_still_added() -> void:
	var resp := _batch([
		## Node 没有 position 属性 → coerce 失败 → 进 failed 列表;节点本身仍入树。
		{"node_type": "Node", "node_name": "_McpTestBatchBadProp", "parent_node_path": "_McpTestBatchArena",
			"properties": {"position": [1, 2, 3]}},
		## 对照节点不带 properties(注意 "name" 在 BLOCKED_PROPERTIES,不能当合法属性用)。
		{"node_type": "Node", "node_name": "_McpTestBatchGoodProp", "parent_node_path": "_McpTestBatchArena"},
	])
	assert_false(resp.has("error"), "A batch with a coerce failure should not fail as a whole (partial failure path): %s" % str(resp.get("error", {})))
	var result: Dictionary = resp.get("result", {})
	## coerce 失败只跳过该 property 的设置,节点仍 add_child → added 计两者。
	assert_eq(int(result.get("added", -1)), 2, "Nodes with a coerce failure still enter the tree, added should be 2")
	assert_eq(_count_tree_children(), int(result.get("added", -1)),
		"The real in-tree count should == added (cross-checked with the failed list semantics)")
	## failed 列表:含节点名 + 失败 key + 错误文本。
	var failed: Array = result.get("failed", [])
	assert_eq(failed.size(), 1, "The failed list should have 1 entry (position coerce failure)")
	if failed.size() == 1:
		var f: Dictionary = failed[0]
		assert_eq(String(f.get("node", "")), "_McpTestBatchBadProp", "The failed entry should record the node name")
		assert_eq(String(f.get("key", "")), "position", "The failed entry should record the failing property key")
		assert_contains(String(f.get("error", "")), "Property not found", "The failed entry's error text should be Property not found")


# ----- test 4: 上限防御 —— >100 节点整体拒绝 -----------------------------------

func test_over_100_nodes_rejected() -> void:
	var nodes: Array = []
	for i in range(101):
		nodes.append({"node_type": "Node", "node_name": "_McpTestBatchOver%d" % i, "parent_node_path": "_McpTestBatchArena"})
	var before := _count_tree_children()
	var resp := _batch(nodes)
	assert_true(resp.has("error"), "101 nodes should be rejected by the limit")
	assert_eq(int(resp.get("error", {}).get("code", 0)), -32004, "The limit rejection error code should be -32004")
	assert_eq(_count_tree_children(), before, "No nodes in the tree after the limit rejection")


# ----- test 5: 多层级 —— 两批次 parent/child 建树,层级真实入树 ------------------
#
# 注意:handle_batch_add_nodes 的 precheck 是两阶段(先全校验后全 instantiate),
# 同批次内 child 的 parent_node_path 指向先定义的节点会因"预校验时该节点尚不
# 存在"被 -32002 整体拒绝(实测语义)。层级须分批次建立。

func test_multi_level_hierarchy_lands_in_tree() -> void:
	var resp1 := _batch([
		{"node_type": "Node", "node_name": "_McpTestBatchParent", "parent_node_path": "_McpTestBatchArena"},
	])
	assert_false(resp1.has("error"), "Batch 1 (Parent) should not fail: %s" % str(resp1.get("error", {})))
	assert_eq(int(resp1.get("result", {}).get("added", -1)), 1, "Batch 1 added should be 1")
	var resp2 := _batch([
		{"node_type": "Node2D", "node_name": "_McpTestBatchChild", "parent_node_path": "_McpTestBatchArena/_McpTestBatchParent"},
	])
	assert_false(resp2.has("error"), "Batch 2 (Child under Parent) should not fail: %s" % str(resp2.get("error", {})))
	assert_eq(int(resp2.get("result", {}).get("added", -1)), 1, "Batch 2 added should be 1")
	## 层级真实入树:Parent 在 arena 下,Child 在 Parent 下,且都在树上。
	var parent_n := CommandHelpers.find_node(_arena, "_McpTestBatchParent")
	assert_true(parent_n != null and parent_n.is_inside_tree(), "Parent should hang under the arena and be in the tree")
	var child_n := CommandHelpers.find_node(_arena, "_McpTestBatchParent/_McpTestBatchChild")
	assert_true(child_n != null and child_n.is_inside_tree(), "Child should hang under Parent and be in the tree")
	if child_n != null and parent_n != null:
		assert_eq(child_n.get_parent(), parent_n, "Child's parent should be Batch 1's Parent")
	## LIFO undo:第一次 undo 撤 Child,第二次撤 Parent(逐层)。
	var did_undo1 := editor_undo(_plugin.get_undo_redo())
	assert_true(did_undo1, "The first editor_undo should succeed")
	assert_true(CommandHelpers.find_node(_arena, "_McpTestBatchChild") == null, "Child should leave the tree after undo")
	assert_true(parent_n != null and is_instance_valid(parent_n), "Parent is still there after undoing Child")
	var did_undo2 := editor_undo(_plugin.get_undo_redo())
	assert_true(did_undo2, "The second editor_undo should succeed")
	assert_eq(_count_tree_children(), 0, "The arena should be empty after two undos")
