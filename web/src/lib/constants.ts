export const PAGE_SIZE = 25;

// Comfortably inside the API's 15-minute access token lifetime.
export const ACCESS_TOKEN_RENEW_MS = 13 * 60 * 1000;

export const WORD_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const SUPPORTED_UPLOAD_ACCEPT =
  ".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// The API wraps search matches in private-use sentinels rather than returning HTML, so nothing
// it produces can be injected into the page. The frontend splits on these to render highlights.
export const SEARCH_HIGHLIGHT_START = "ARCHIVE_ENGINE_SEARCH_START";
export const SEARCH_HIGHLIGHT_END = "ARCHIVE_ENGINE_SEARCH_END";
