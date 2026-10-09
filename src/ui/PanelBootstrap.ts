export type PanelBootstrapDocument = {
  html: string;
  recovered: boolean;
  error?: string;
};

function bootstrapErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const message = String(error || "面板 HTML 渲染失败。").trim();
  return message || "面板 HTML 渲染失败。";
}

export function renderPanelBootstrapDocument(
  renderPanel: () => string,
  renderRecovery: (message: string) => string,
): PanelBootstrapDocument {
  try {
    const html = renderPanel();
    if (!String(html || "").trim()) throw new Error("面板 HTML 渲染结果为空。");
    return { html, recovered: false };
  } catch (error) {
    const message = bootstrapErrorMessage(error);
    return { html: renderRecovery(message), recovered: true, error: message };
  }
}
