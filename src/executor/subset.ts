import { Language } from "../common/types.js";

const PYTHON_DENYLIST = [
  /\bexec\(/,
  /\beval\(/,
  /\bcompile\(/,
  /__import__/,
  /\bimport\s+os\b/,
  /\bimport\s+subprocess\b/,
  /\bopen\(/,
  /\bsocket\b/
];

const JS_DENYLIST = [
  /\beval\(/,
  /\bFunction\(/,
  /\brequire\(/,
  /\bprocess\./,
  /\bfs\./,
  /\bchild_process\b/
];

export interface SubsetCheck {
  supported: boolean;
  reason?: string;
}

export function checkSubset(language: Language, code: string): SubsetCheck {
  const denylist = language === "python" ? PYTHON_DENYLIST : JS_DENYLIST;
  for (const pattern of denylist) {
    if (pattern.test(code)) {
      return {
        supported: false,
        reason: `Unsupported construct detected: ${pattern.source}`
      };
    }
  }
  return { supported: true };
}
