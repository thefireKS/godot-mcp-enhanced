extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin


# CMP-16-A (2026-08-08): param docs metadata。
func get_command_docs() -> Dictionary:
	return {
		"export_list_presets": {
			"description": "List all export presets of the project.",
			"params": [],
		},
		"export_get_preset": {
			"description": "Details of an export preset.",
			"params": [
				CommandHelpers.doc_param("name", "String", true, "Export preset name"),
			],
		},
		"export_build": {
			"description": "Build the export with a preset.",
			"params": [
				CommandHelpers.doc_param("preset", "String", true, "Export preset name, must exist"),
			],
		},
	}


func handle_export_list_presets(params: Dictionary) -> Dictionary:
	if _plugin == null:
		return {"error": {"code": -32000, "message": "Editor plugin not available"}}
	var ei = _plugin.get_editor_interface()
	if ei == null:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}
	var presets = ei.get_export_presets()
	var result = []
	for i in range(presets.size()):
		var p = presets[i]
		result.append({
			"name": str(p.get("name", "Preset %d" % i)),
			"platform": str(p.get("platform", "unknown")),
			"runnable": p.is_runnable() if p.has_method("is_runnable") else false
		})
	return {"result": {"presets": result, "count": result.size()}}

func handle_export_get_preset(params: Dictionary) -> Dictionary:
	var preset_name: String = params.get("name", "")
	if preset_name == "":
		return {"error": {"code": -32004, "message": "Preset name required"}}
	if _plugin == null:
		return {"error": {"code": -32000, "message": "Editor plugin not available"}}
	var ei = _plugin.get_editor_interface()
	if ei == null:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}
	var presets = ei.get_export_presets()
	for i in range(presets.size()):
		var p = presets[i]
		if str(p.get("name", "")) == preset_name:
			var data = {}
			for key in p.get_property_list():
				# 2026-08-07 审查 P1 修复：get_property_list() 可能含无 "name" 键的
				# 元属性条目（group/section/usage flag 虚拟条目），直索引 key["name"]
				# 触发 SCRIPT_ERROR "Invalid index 'name'" 中断整个循环 → 客户端 30s 超时。
				# 对齐同文件 :19/:37/:76 的 .get("name","") 防御模式。
				if not (key is Dictionary):
					continue
				var prop_name: String = String(key.get("name", ""))
				if prop_name.is_empty():
					continue
				if prop_name.begins_with("resource_"):
					continue
				var val = p.get(prop_name)
				if _is_sensitive_key(prop_name):
					data[prop_name] = "***"
				else:
					# P2-2: 非标量类型（Resource/Object 引用）白名单化，防 JSON.stringify
					# 递归序列化失败致 reply 发不出→客户端 30s 超时
					var t: int = typeof(val)
					match t:
						TYPE_STRING, TYPE_INT, TYPE_FLOAT, TYPE_BOOL, TYPE_NIL:
							data[prop_name] = val
						TYPE_ARRAY, TYPE_DICTIONARY:
							# GD-R9 (2026-08-08): 改用 JSON.stringify 保留嵌套结构(AI 可靠解析)。
							# 原 str(val) 返 Godot print 格式("[1, 2, 3]" 带空格)非合法 JSON。
							# P2-2 教训:容器内若嵌套 Object/Resource,JSON.stringify 会失败。
							# GDScript 无 try/catch——靠 JSON.stringify 遇不可序列化时返 "" 检测降级回 str(val)。
							var json_str := JSON.stringify(val)
							if json_str != "":
								data[prop_name] = JSON.parse_string(json_str)  # 还原为原生结构(dict 包装 JSON 化)
							else:
								data[prop_name] = str(val)
						_:
							# Object/Resource/Vector/Color 等 → str(无法 JSON 化)
							data[prop_name] = str(val)
			return {"result": data}
	return {"error": {"code": -32002, "message": "Export preset not found: " + preset_name}}

func handle_export_build(params: Dictionary) -> Dictionary:
	var preset_name: String = params.get("preset", "")
	if preset_name == "":
		return {"error": {"code": -32004, "message": "Preset name required"}}
	if _plugin == null:
		return {"error": {"code": -32000, "message": "Editor plugin not available"}}
	var ei = _plugin.get_editor_interface()
	if ei == null:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}
	# Find the preset
	var presets = ei.get_export_presets()
	var found = false
	for i in range(presets.size()):
		var p = presets[i]
		if str(p.get("name", "")) == preset_name:
			found = true
			break
	if not found:
		return {"error": {"code": -32002, "message": "Export preset not found: " + preset_name}}
	# Export build requires EditorExportPlatform API (not fully scriptable in GDScript)
	# This is a stub — validates preset exists but does not trigger actual build
	# G-I-08: 返回 error(非 result)避免 AI 误判导出已触发。原 stub 走 success 路径,
	# 客户端看顶层 success 可能以为导出成功,实际未触发任何构建。
	return {"error": {"code": -32001, "message": "Export build not implemented (stub). EditorExportPlatform API is limited, use editor GUI. Preset validated: " + preset_name}}

func _is_sensitive_key(key: String) -> bool:
	var sensitive_patterns = ["keystore", "certificate", "codesign", "identity", "provisioning", "password", "secret", "token", "api_key"]
	var k = key.to_lower()
	for pattern in sensitive_patterns:
		if k.contains(pattern):
			return true
	return false
