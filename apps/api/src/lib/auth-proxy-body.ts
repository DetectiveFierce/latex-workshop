type ParsedFormValue = string | number | boolean | null | ParsedFormValue[];

export function serializeAuthProxyBody(
  contentType: string | undefined,
  body: unknown,
): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (contentType?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    if (!isParsedForm(body)) return undefined;
    const encoded = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) appendFormValue(encoded, key, value);
    return encoded;
  }
  return JSON.stringify(body);
}

function isParsedForm(value: unknown): value is Record<string, ParsedFormValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isParsedFormValue);
}

function isParsedFormValue(value: unknown): value is ParsedFormValue {
  return (
    value === null ||
    ['string', 'number', 'boolean'].includes(typeof value) ||
    (Array.isArray(value) && value.every(isParsedFormValue))
  );
}

function appendFormValue(params: URLSearchParams, key: string, value: ParsedFormValue): void {
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(params, key, item);
    return;
  }
  if (value !== null) params.append(key, String(value));
}
