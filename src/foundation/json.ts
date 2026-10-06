export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** JSON persistence must not silently turn undefined/NaN/class instances into other values. */
export function assertJson(value: unknown, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) throw new Error('Value is not lossless JSON');
  if (ancestors.has(value)) throw new Error('Cyclic JSON value');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error('JSON containers must have no custom prototype');
  }
  if (Object.getOwnPropertySymbols(value).length) throw new Error('JSON cannot preserve symbol properties');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) throw new Error('JSON array has holes or extra properties');
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('JSON array has holes or computed properties');
        assertJson(descriptor.value, ancestors);
      }
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('JSON object has hidden or computed properties');
        assertJson(descriptor.value, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

export function encodeJson(value: unknown): string {
  assertJson(value);
  return JSON.stringify(value);
}

export function jsonObject(value: unknown, label: string): Record<string, JsonValue> {
  assertJson(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
