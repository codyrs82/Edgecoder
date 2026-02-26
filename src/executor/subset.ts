// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { Language } from "../common/types.js";
import { validatePythonAst } from "./ast-python.js";
import { validateJavaScriptAst } from "./ast-javascript.js";

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

export async function checkSubset(language: Language, code: string): Promise<SubsetCheck> {
  // Fast pre-filter: regex denylist
  const denylist = language === "python" ? PYTHON_DENYLIST : JS_DENYLIST;
  for (const pattern of denylist) {
    if (pattern.test(code)) {
      return {
        supported: false,
        reason: `Unsupported construct detected: ${pattern.source}`
      };
    }
  }

  // Authoritative check: AST validation
  if (language === "python") {
    const astResult = await validatePythonAst(code);
    if (!astResult.safe) {
      return { supported: false, reason: astResult.reason };
    }
  } else {
    const astResult = validateJavaScriptAst(code);
    if (!astResult.safe) {
      return { supported: false, reason: astResult.reason };
    }
  }

  return { supported: true };
}
