/** A view may open a web page only: absolute http(s), nothing else the system browser could run. */
export function openableUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only http and https URLs can be opened.");
  return url.href;
}
