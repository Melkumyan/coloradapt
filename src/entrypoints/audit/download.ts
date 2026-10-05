/** Saves `text` as a file through the browser's own download (no permission, no network). */
export function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download has started by the time the click returns; the URL is not needed after that.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
