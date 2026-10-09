export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_ENV = 2;
export const EXIT_BUSINESS = 3;
export const EXIT_NETWORK = 4;

export type CliExitCode = 0 | 1 | 2 | 3 | 4;

export class CliError extends Error {
  readonly exitCode: Exclude<CliExitCode, 0>;
  readonly code: string;
  readonly detail: string;

  constructor(exitCode: Exclude<CliExitCode, 0>, code: string, message: string, detail = "") {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.detail = detail;
  }
}

export function usageError(message: string, detail = ""): CliError {
  return new CliError(EXIT_USAGE, "USAGE", message, detail);
}

export function envError(message: string, detail = ""): CliError {
  return new CliError(EXIT_ENV, "ENV", message, detail);
}

export function businessError(message: string, detail = ""): CliError {
  return new CliError(EXIT_BUSINESS, "BUSINESS", message, detail);
}

export function networkError(message: string, detail = ""): CliError {
  return new CliError(EXIT_NETWORK, "NETWORK", message, detail);
}

export function jsonErrorBody(error: CliError): { success: false; error: { code: string; message: string; detail: unknown } } {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      detail: parseDetail(error.detail || ""),
    },
  };
}

function parseDetail(value: string): unknown {
  const text = String(value || "");
  if (!text.startsWith("{")) return text;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

export function asCliError(error: unknown, fallback: Exclude<CliExitCode, 0> = EXIT_BUSINESS): CliError {
  if (error instanceof CliError) return error;
  const err = error as { code?: string; message?: string };
  const message = error instanceof Error ? error.message : String(error);
  const code = String(err?.code || "");
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code) || /timed out|ECONNREFUSED/i.test(message)) {
    return networkError(message, code);
  }
  if (/discovery not found|discovery is invalid|Open VS Code/i.test(message)) {
    return envError(message, code);
  }
  return new CliError(fallback, code || "ERROR", message, code);
}
