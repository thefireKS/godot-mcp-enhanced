// src/core/args-validator.ts
/**
 * 手写 JSON schema 参数验证器(spec §2)。
 * 覆盖 inputSchema 实际用的关键字:type / required / enum / items(递归) / properties(嵌套)。
 * 不覆盖(YAGNI):pattern/format/minLength/maxItems/additionalProperties(未知字段允许)。
 */

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function actualType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkType(value: unknown, expected: string | string[]): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((t) => TYPE_CHECKS[t]?.(value) ?? false);
}

interface SubSchema {
  type?: string | string[];
  enum?: unknown[];
  items?: SubSchema;
  properties?: Record<string, SubSchema>;
  required?: string[];
}

function validateValue(value: unknown, schema: SubSchema, path: string, errors: string[]): void {
  // type
  if (schema.type !== undefined && !checkType(value, schema.type)) {
    const exp = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
    errors.push(`${path}: expected type ${exp}, got ${actualType(value)}`);
    return; // 类型错,后续 enum/items/properties 跳过(避免噪音)
  }
  // enum
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} is not in enum [${schema.enum.map((e) => String(e)).join(',')}]`);
  }
  // items 递归(array 元素)
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateValue(item, schema.items as SubSchema, `${path}[${i}]`, errors));
  }
  // properties 嵌套(object)
  if (checkType(value, 'object') && schema.properties) {
    validateObject(value as Record<string, unknown>, schema, path, errors);
  }
}

function validateObject(obj: Record<string, unknown>, schema: SubSchema, path: string, errors: string[]): void {
  // required
  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in obj)) errors.push(`${path}.${req}: required field missing`);
    }
  }
  // properties(只校验出现的字段;未知字段允许)
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj && sub) {
        validateValue(obj[key], sub as SubSchema, `${path}.${key}`, errors);
      }
    }
  }
}

export function validateArgs(args: Record<string, unknown>, inputSchema: object): ValidationResult {
  const errors: string[] = [];
  const schema = inputSchema as SubSchema;
  // inputSchema 顶层是 object(MCP 惯例),校验 args 的 properties/required
  if (schema.properties || schema.required) {
    validateObject(args, schema, 'args', errors);
  }
  return { ok: errors.length === 0, errors };
}
