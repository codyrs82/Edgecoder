/// <reference types="vite/client" />
// #11: bundle Monaco's web workers with Vite so the editor runs under the production CSP
// (script-src 'self', no 'unsafe-eval'). Without MonacoEnvironment, Monaco falls back to
// blob/eval-based worker loading. Import this before monaco-editor.
// #13: monaco-editor 0.57 exports "./*" -> "./esm/vs/*.js", so deep imports drop "esm/vs/".
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};
