extends Node

# CMP-4 (2026-08-08): engine 组 — 实时 ClassDB 内省(editor-only)
# 让 AI 发现运行中引擎的实际可用类/方法/属性/信号/枚举。
# 补静态 extension_api.json(4.7 快照,不含第三方 addon/自定义类/4.6/4.8 差异)的缺口。
#
# 走 editor 层直调 ClassDB(不经 gdscript-executor 沙箱——ClassDB 在沙箱里被列为危险模式)。
# 已有先例:node_commands.gd:60/237 ClassDB.instantiate, ui_commands.gd:45/357 同款。

var _plugin: EditorPlugin

# search 结果上限(防全量 1000+ 类 × 子串匹配返回过大)
const SEARCH_LIMIT := 100
# CMP-4-R1: class_info 单类成员上限(防 Node 400+ 方法序列化撑爆 1MB → send_text ERR_INVALID_DATA → -32010)
const MEMBER_LIMIT := 200

# CMP-9-A (2026-08-08): call_method 危险方法 deny-list。
# 默认挡:节点销毁(free/queue_free/queue_delete)、运行时结构修改(add_child/remove_child/set_owner)、
# 间接调用(call/callv/call_deferred,绕 deny-list)、脚本注入(set_script=RCE)、信号拓扑(connect/disconnect/emit_signal)。
# 对标竞品 regiellis/godot-mcp-go 的 node.call 无过滤是缺陷;enhanced 坚持 deny-list 护城河。
# env GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE 可追加(逗号分隔,env ∪ 默认表,只能加不能减;A3 2026-08-11 原替换语义是 footgun)。显式设空串=完全放开(风险自担)。
# B-2 (2026-08-14): 原写的无下划线拼写(callthreadsafe 连写)是拼写错误——Godot 4 真实
# 方法名 call_thread_safe(data/godot-classes.json 实证:定义于 Node),错误拼写永不命中 →
# deny-list 被绕。补 propagate_call(子树递归调用,同 call_thread_safe 是间接调用入口)。
# 拼写契约由 test/denylist-godot-classes-contract.test.ts 从 godot-classes.json 生成守护。
const DEFAULT_CALL_DENYLIST := [
	"free", "queue_free", "queue_delete",
	"add_child", "remove_child", "set_owner",
	"call", "callv", "call_deferred", "call_thread_safe", "propagate_call",
	"set_script", "set", "set_indexed",  # P2-1 (2026-08-11): 通用 property setter,可 callv("set",["script",val]) 绕 set_script deny
	"emit_signal", "connect", "disconnect",
]
# call_method args 数量上限(对标 bridge _cmd_call_method:939 的 8 限制)
const CALL_ARGS_LIMIT := 8


func setup(plugin: EditorPlugin, _undo_manager: Node = null) -> void:
	_plugin = plugin


func cleanup() -> void:
	_plugin = null


# CMP-16-A (2026-08-08): param docs metadata(对标竞品 get_command_docs)。
# 供 TS 侧 live schema 构建拉取(command_handler.gd list_param_docs 聚合)。
func get_command_docs() -> Dictionary:
	return {
		"engine_class_info": {
			"description": "Full structure of one class (properties/methods/signals/enums/inheritance). Default no_inherit=true shows only its own members.",
			"params": [
				CommandHelpers.doc_param("class", "String", true, "Class name (e.g. Node, Sprite2D, RigidBody3D, or a class registered by a third-party addon)"),
				CommandHelpers.doc_param("no_inherit", "bool", false, "true = own members only (default); false = merge the inheritance chain"),
			],
		},
		"engine_search": {
			"description": "Substring match on class names (case-insensitive, returns a {name, parent} list, max 100). Sorted alphabetically before truncation.",
			"params": [
				CommandHelpers.doc_param("query", "String", true, "Substring to match class names"),
			],
		},
		"engine_get_inheritance": {
			"description": "The class inheritance chain (from the class up to Object). With full cycle detection.",
			"params": [
				CommandHelpers.doc_param("class", "String", true, "Class name"),
			],
		},
		# CMP-9-A (2026-08-08): call_method — 编辑器场景树节点实例方法调用
		"engine_call_method": {
			"description": "Call an instance method on a node in the editor scene tree (like node.call). The deny-list blocks dangerous methods by default (free/queue_free/set_script/call etc.); env GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE adds to it (union with the default list, can only add; an explicit empty string lifts it). args are coerced to the declared parameter types. Calls cannot be undone (response undoable=false).",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "Target node path (e.g. root/Player, relative to the editor scene tree root)"),
				CommandHelpers.doc_param("method", "String", true, "Method to call (unknown methods get did-you-mean suggestions)"),
				CommandHelpers.doc_param("args", "Array", false, "Positional arguments (coerced to the declared parameter types, max 8)"),
			],
		},
	}


# ─── ClassDB 内省 ─────────────────────────────────────────────────────────────

# 查单个类的结构:属性/方法/信号/枚举/继承。
# no_inherit=true(默认)只看本类 own 成员;false 含继承链合并。
func handle_class_info(params: Dictionary) -> Dictionary:
	var class_name_: String = params.get("class", "")
	if class_name_ == "":
		return {"error": {"code": -32602, "message": "class is required (e.g. 'Node', 'Sprite2D', 'RigidBody3D')"}}
	if not ClassDB.class_exists(class_name_):
		return {"error": {"code": -32604, "message": "Class '%s' does not exist in ClassDB. Use engine.search to find available classes." % class_name_}}
	var no_inherit: bool = params.get("no_inherit", true)
	var info: Dictionary = {}
	info["name"] = class_name_
	info["parent"] = ClassDB.get_parent_class(class_name_)
	info["can_instantiate"] = ClassDB.can_instantiate(class_name_)
	# CMP-4-R1: 各类成员截断标志(任一类别超 MEMBER_LIMIT 则 truncated=true)
	var truncated := false
	# 属性
	var props: Array = ClassDB.class_get_property_list(class_name_, no_inherit)
	var prop_out: Array = []
	for p in props:
		# 过滤 metadata 级别 property(只有 name+usage 无 type 的)
		# CMP-4-R2: 过滤 PROPERTY_USAGE_INTERNAL(0x2) 属性(AI 不应见 internal,误当公开 API 调)
		if p is Dictionary and p.has("name") and p.has("type"):
			if int(p.get("usage", 0)) & PROPERTY_USAGE_INTERNAL:
				continue
			if prop_out.size() >= MEMBER_LIMIT:
				truncated = true
				break
			prop_out.append({"name": p["name"], "type": _type_name(int(p["type"])), "class_name": String(p.get("class_name", ""))})
	info["properties"] = prop_out
	info["property_count"] = prop_out.size()
	# 方法
	var methods: Array = ClassDB.class_get_method_list(class_name_, no_inherit)
	var method_out: Array = []
	for m in methods:
		if m is Dictionary and m.has("name"):
			if method_out.size() >= MEMBER_LIMIT:
				truncated = true
				break
			var args_out: Array = []
			if m.has("args"):
				for a in m["args"]:
					if a is Dictionary and a.has("name"):
						args_out.append({"name": a["name"], "type": _type_name(int(a.get("type", 0)))})
			method_out.append({"name": m["name"], "return_type": _type_name(int(m.get("return_type", 0))), "args": args_out})
	info["methods"] = method_out
	info["method_count"] = method_out.size()
	# 信号
	var signals: Array = ClassDB.class_get_signal_list(class_name_, no_inherit)
	var signal_out: Array = []
	for s in signals:
		if s is Dictionary and s.has("name"):
			if signal_out.size() >= MEMBER_LIMIT:
				truncated = true
				break
			signal_out.append(s["name"])
	info["signals"] = signal_out
	# 枚举
	# GD-R4 (2026-08-08): 补 enum constants(用 class_get_enum_constants),AI 可知枚举可选值。
	# 原 class_get_enum_list 只返枚举名(如 ["Button","Vector2.Axis"]),AI 无法知道常量/值。
	var enums: Array = ClassDB.class_get_enum_list(class_name_, no_inherit)
	var enum_out: Array = []
	const ENUM_CONSTANTS_LIMIT := 50  # 单 enum 常量上限(防巨型 enum 如 Key 撑爆)
	for e in enums:
		if enum_out.size() >= MEMBER_LIMIT:
			truncated = true
			break
		var constants: PackedStringArray = ClassDB.class_get_enum_constants(class_name_, e, no_inherit)
		var const_out: Array = []
		for c in constants:
			if const_out.size() >= ENUM_CONSTANTS_LIMIT:
				truncated = true
				break
			# class_get_integer_constant 拿值(供 AI 理解枚举值范围)
			const_out.append({"name": c, "value": ClassDB.class_get_integer_constant(class_name_, c)})
		enum_out.append({"name": e, "constants": const_out})
	info["enums"] = enum_out
	# CMP-4-R1: 截断时提示 AI 改用 no_inherit=true 只看本类成员(避免 1MB 撑爆)
	info["truncated"] = truncated
	if truncated:
		info["truncation_hint"] = "Output truncated at %d members per category. Use no_inherit=true to see only own members, or search for a specific class." % MEMBER_LIMIT
	return {"result": info}


# substring 匹配类名(不做全方法 sweep——1000+ 类 × property_list 是 O(N) 太慢)。
# AI 搜到类名后用 class_info 查具体成员。
func handle_search(params: Dictionary) -> Dictionary:
	var query: String = params.get("query", "")
	if query == "":
		return {"error": {"code": -32602, "message": "query is required (substring to match class names)"}}
	var query_lower := query.to_lower()
	var all_classes: PackedStringArray = ClassDB.get_class_list()
	var matches: Array = []
	# GD-R6 (2026-08-08): 先 collect 全部 matches 再字母序排序再截断(原按 ClassDB 注册序截断,
	# AI 搜 "Node" 拿到的结果跨 Godot 版本/addon 组合不可预测,字母序靠后的相关类可能被丢弃)。
	for cls in all_classes:
		if cls.to_lower().contains(query_lower):
			matches.append({"name": cls, "parent": ClassDB.get_parent_class(cls)})
	# 字母序排序(让 AI 看到可预测的、相关性更均匀的结果)
	matches.sort_custom(func(a, b): return a["name"] < b["name"])
	# 排序后截断到 SEARCH_LIMIT(用 flag 记录是否真因 limit 提前退出,避免恰好 == LIMIT 假阳性)
	var hit_limit := matches.size() > SEARCH_LIMIT
	if hit_limit:
		matches = matches.slice(0, SEARCH_LIMIT)
	return {"result": {"matches": matches, "count": matches.size(), "truncated": hit_limit, "query": query}}


# 返回类的继承链(从本类到 Object)。
func handle_get_inheritance(params: Dictionary) -> Dictionary:
	var class_name_: String = params.get("class", "")
	if class_name_ == "":
		return {"error": {"code": -32602, "message": "class is required"}}
	if not ClassDB.class_exists(class_name_):
		return {"error": {"code": -32604, "message": "Class '%s' does not exist in ClassDB." % class_name_}}
	var chain: Array = [class_name_]
	# CMP-4-R4: 用 visited Set 做完整环检测,破 A→B→A 互循环(原 parent==current 只破 A→A 自引用)
	var visited: Dictionary = {class_name_: true}
	var current: String = class_name_
	for i in 100:  # 防御性上限
		var parent: String = ClassDB.get_parent_class(current)
		if parent == "" or visited.has(parent):
			break
		chain.append(parent)
		visited[parent] = true
		current = parent
	return {"result": {"chain": chain, "depth": chain.size()}}


# ─── CMP-9-A (2026-08-08): call_method — 编辑器场景树节点实例方法调用 ──────────
#
# 对标竞品 regiellis/godot-mcp-go 的 node.call(在编辑器场景树上调实例方法)。
# 补 engine 组(只有 ClassDB 内省,无方法调用)的能力缺口。
#
# 安全设计(核心护城河):
# - deny-list 默认挡危险方法(free/queue_free/set_script=call/callv/emit_signal...)
# - env GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE 可定制(显式 opt-in)
# - args 类型强转(按 ClassDB method 声明类型,防 Vector3 传单值静默变 0)
# - did-you-mean(方法不存在时给最接近建议,降 AI 重试成本)
# - undoable=false 显式声明(call 不可 undo)
func handle_call_method(params: Dictionary) -> Dictionary:
	var node_path: String = params.get("node_path", "")
	var method: String = params.get("method", "")
	if node_path == "":
		return {"error": {"code": -32602, "message": "node_path is required (e.g. 'root/Player', 'Player/Sprite2D')"}}
	if method == "":
		return {"error": {"code": -32602, "message": "method is required (method name to call on the node)"}}

	# 1. 解析节点(经 EditorInterface 场景树)
	var ei: EditorInterface = _plugin.get_editor_interface() if _plugin != null else null
	if ei == null:
		return {"error": {"code": -32000, "message": "EditorInterface not available (editor-only)"}}
	var root: Node = ei.get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene loaded. Open a scene in the editor first."}}
	var node: Node = CommandHelpers.find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32604, "message": "Node not found: %s" % node_path}}

	# 2. deny-list 检查(env 可覆盖)
	var denylist := _resolve_call_denylist()
	if method in denylist:
		# B-2 (2026-08-14): 内层检查——间接调用入口(call/callv/call_deferred/call_thread_safe/
		# propagate_call)的 args[0] 是内层方法名。deny 方法命中时若 args[0] 也是 deny 方法
		# (如 call_thread_safe + set_script),拒绝信息一并标注内外两层(纵深防御 + 诊断增强)。
		# 仅 deny 命中分支内检查,正常方法(如 set_position)的 args[0] 不受影响。
		var inner_note := ""
		var probe_args: Array = params.get("args") if params.get("args") is Array else []
		if probe_args.size() > 0 and probe_args[0] is String and denylist.has(probe_args[0]):
			inner_note = " Inner method '%s' is also in the deny-list." % probe_args[0]
		return {"error": {"code": -6, "message": "Method blocked by deny-list (dangerous, changes runtime structure or enables RCE): %s.%s Set env GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE to customize." % [method, inner_note]}}

	# 3. 方法存在性 + did-you-mean
	if not node.has_method(method):
		var suggestion := _suggest_method(node, method)
		var hint := "Use engine class_info with the node's class to list its methods."
		if suggestion != "":
			hint = "Did you mean '%s'? %s" % [suggestion, hint]
		return {"error": {"code": -32604, "message": "Method '%s' not found on %s. %s" % [method, node.get_class(), hint]}}

	# 4. 参数数量 + 类型强转(按 ClassDB 声明类型)
	var raw_args: Array = []
	if params.has("args") and params.get("args") is Array:
		raw_args = params["args"]
	if raw_args.size() > CALL_ARGS_LIMIT:
		return {"error": {"code": -4, "message": "Too many arguments (max %d)" % CALL_ARGS_LIMIT}}
	var coerce_result := _coerce_call_args(node, method, raw_args)
	if not coerce_result["ok"]:
		return {"error": {"code": -32602, "message": "Argument coercion failed: %s" % coerce_result["reason"]}}
	var coerced_args: Array = coerce_result["args"]

	# 5. 执行(audit 日志对标竞品 audit_exec + enhanced GODOT_MCP_AUDIT_CODE)
	if OS.get_environment("GODOT_MCP_AUDIT_CODE").to_lower() == "true":
		print("[MCP audit] engine.call_method: %s(%s).%s(%s)" % [node.name, node.get_class(), method, str(coerced_args)])
	var returned: Variant = node.callv(method, coerced_args)

	# 6. 序列化返回值 + undoable=false
	return {"result": {
		"node_path": node_path,
		"method": method,
		"return_value": _serialize_return_value(returned),
		"undoable": false,
	}}


# ─── Helpers ─────────────────────────────────────────────────────────────────

# CMP-9-A: 解析 call_method deny-list。
# A3 (2026-08-11 审查): env 非空改「追加」语义(env ∪ DEFAULT_CALL_DENYLIST)。
# 原「完全替换」是 footgun——用户想多挡一个方法(如 =notification)会丢掉
# free/queue_free/set_script 全部默认防护;空串更是清空整个默认表。
# 现:env 未设 → 默认表;env 非空 → 默认表 + env 追加(只能加不能减);
# env 显式设为空字符串 → 清空(完全放开,风险自担的唯一显式逃生口)。
func _resolve_call_denylist() -> PackedStringArray:
	var env_val := OS.get_environment("GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE")
	if env_val == "" and OS.has_environment("GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE"):
		# env 显式设为空字符串 = 清空 deny-list(完全放开,风险自担)
		return PackedStringArray()
	# env 未设(用默认表)或非空(默认表 + 追加)
	var result: PackedStringArray = PackedStringArray(DEFAULT_CALL_DENYLIST)
	for m in env_val.split(","):
		var trimmed := m.strip_edges()
		if trimmed != "" and not result.has(trimmed):
			result.append(trimmed)
	return result


# CMP-9-A: did-you-mean — 方法不存在时给最接近建议(对标竞品 _suggest_method)。
# 遍历 node.get_method_list(),String.similarity > 0.6 取最高分。
func _suggest_method(node: Node, target: String) -> String:
	var best := ""
	var best_score := 0.6
	for m in node.get_method_list():
		if m is Dictionary and m.has("name"):
			var name_: String = m["name"]
			var score: float = target.similarity(name_)
			if score > best_score:
				best_score = score
				best = name_
	return best


# CMP-9-A: args 类型强转(对标竞品 PropertyParser.coerce_call_args)。
# 按 ClassDB method_get_info 拿每个参数的声明类型,把 JSON 值强转成 Godot 类型。
# 防 AI 传 Array [1,2,3] 给 Vector3 参数静默变零值(Godot callv 不自动转)。
# 返回 {"ok": bool, "args": Array, "reason": String}。
func _coerce_call_args(node: Node, method: String, raw_args: Array) -> Dictionary:
	# NIT-5 修正:用循环赋值替代 filter().front()(后者空数组返 null 赋 Dictionary 有类型隐患)
	var method_info: Dictionary = {}
	for m in node.get_method_list():
		if m is Dictionary and m.get("name", "") == method:
			method_info = m
			break
	# 取不到 method info(如动态方法/内置)→ 不强转,透传 raw_args(callv 自己处理)
	if method_info.is_empty() or not method_info.has("args"):
		return {"ok": true, "args": raw_args, "reason": ""}
	var declared_args: Array = method_info["args"]
	# 参数数量校验(可变参数方法 args 可能少于实际;严格校验固定参数)
	# NIT-6 修正:ClassDB method args 的默认值键名是 "default_value"(非 "default")
	if declared_args.size() > 0:
		var fixed_count := 0
		for da in declared_args:
			if da is Dictionary and not da.has("default_value"):
				fixed_count += 1
			else:
				break
		# 宽松:raw_args 至少覆盖无默认值的参数
		if raw_args.size() < declared_args.size() and raw_args.size() < fixed_count:
			return {"ok": false, "args": [], "reason": "expected at least %d args, got %d" % [fixed_count, raw_args.size()]}
	var coerced: Array = []
	for i in range(raw_args.size()):
		var raw: Variant = raw_args[i]
		if i < declared_args.size() and declared_args[i] is Dictionary:
			var declared_type: int = int(declared_args[i].get("type", TYPE_NIL))
			coerced.append(_coerce_single_arg(raw, declared_type))
		else:
			# 超出声明参数(可变参数场景)→ 透传
			coerced.append(raw)
	return {"ok": true, "args": coerced, "reason": ""}


# CMP-9-A: 单个参数强转。按 Variant.Type 分支。
func _coerce_single_arg(raw: Variant, declared_type: int) -> Variant:
	match declared_type:
		TYPE_VECTOR2:
			if raw is Array and raw.size() >= 2:
				return Vector2(float(raw[0]), float(raw[1]))
			if raw is String:
				return Vector2(raw)
		TYPE_VECTOR2I:
			if raw is Array and raw.size() >= 2:
				return Vector2i(int(raw[0]), int(raw[1]))
		TYPE_VECTOR3:
			if raw is Array and raw.size() >= 3:
				return Vector3(float(raw[0]), float(raw[1]), float(raw[2]))
			if raw is String:
				return Vector3(raw)
		TYPE_VECTOR3I:
			if raw is Array and raw.size() >= 3:
				return Vector3i(int(raw[0]), int(raw[1]), int(raw[2]))
		TYPE_VECTOR4:
			if raw is Array and raw.size() >= 4:
				return Vector4(float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]))
		TYPE_COLOR:
			if raw is Array and raw.size() >= 3:
				var a: float = float(raw[3]) if raw.size() > 3 else 1.0
				return Color(float(raw[0]), float(raw[1]), float(raw[2]), a)
		TYPE_BOOL:
			if raw is String:
				return raw.to_lower() == "true"
			if raw is float or raw is int:
				return bool(raw)
		TYPE_INT:
			if raw is String:
				return int(raw)
			if raw is float:
				return int(raw)
		TYPE_FLOAT:
			if raw is String:
				return float(raw)
			if raw is int:
				return float(raw)
		TYPE_STRING:
			return str(raw)
		TYPE_NODE_PATH:
			return NodePath(str(raw))
	return raw


# CMP-9-A: 序列化 call_method 返回值(JSON 友好)。
# 复用 mcp_bridge.gd _jsonify 同款逻辑(数学类型 → dict,Resource → {type,path},Node → path string)。
func _serialize_return_value(val: Variant) -> Variant:
	if val == null:
		return null
	if val is Vector2:
		return {"x": val.x, "y": val.y}
	if val is Vector2i:
		return {"x": val.x, "y": val.y}
	if val is Vector3:
		return {"x": val.x, "y": val.y, "z": val.z}
	if val is Vector3i:
		return {"x": val.x, "y": val.y, "z": val.z}
	if val is Vector4:
		return {"x": val.x, "y": val.y, "z": val.z, "w": val.w}
	if val is Color:
		return {"r": val.r, "g": val.g, "b": val.b, "a": val.a}
	if val is Rect2:
		return {"x": val.position.x, "y": val.position.y, "w": val.size.x, "h": val.size.y}
	if val is Resource:
		return {"type": val.get_class(), "path": val.resource_path if val.resource_path else ""}
	if val is Node:
		return str(val.get_path())
	if val is Object:
		return {"type": val.get_class(), "instance_id": val.get_instance_id()}
	return val


# Variant.Type int → 可读名称（Godot 4.x Variant.Type 枚举值,经官方文档核实 4.4-4.7 一致）
func _type_name(type: int) -> String:
	# B-2 (2026-08-08 第三方审查): 补 Projection(19) + PackedVector4Array(38),
	# 修复 off-by-two（原表漏 Projection 致 19+ 全部错位）。
	match type:
		0: return "NIL"
		1: return "bool"
		2: return "int"
		3: return "float"
		4: return "String"
		5: return "Vector2"
		6: return "Vector2i"
		7: return "Rect2"
		8: return "Rect2i"
		9: return "Vector3"
		10: return "Vector3i"
		11: return "Transform2D"
		12: return "Vector4"
		13: return "Vector4i"
		14: return "Plane"
		15: return "Quaternion"
		16: return "AABB"
		17: return "Basis"
		18: return "Transform3D"
		19: return "Projection"
		20: return "Color"
		21: return "StringName"
		22: return "NodePath"
		23: return "RID"
		24: return "Object"
		25: return "Callable"
		26: return "Signal"
		27: return "Dictionary"
		28: return "Array"
		29: return "PackedByteArray"
		30: return "PackedInt32Array"
		31: return "PackedInt64Array"
		32: return "PackedFloat32Array"
		33: return "PackedFloat64Array"
		34: return "PackedStringArray"
		35: return "PackedVector2Array"
		36: return "PackedVector3Array"
		37: return "PackedColorArray"
		38: return "PackedVector4Array"
		_: return "type_%d" % type
