// Agent Skills metadata — single source of truth for /dashboard/skills page.
// Copied links point at this app (`/api/skills/:id`) so they work without a public GitHub repo.

const REPO = process.env.NEXT_PUBLIC_GITHUB_REPO || "";
const BRANCH = process.env.NEXT_PUBLIC_GITHUB_BRANCH || "master";
const SKILL_PATH = "skills";

export const SKILLS_REPO_URL = REPO ? `https://github.com/${REPO}` : "";
export const SKILLS_RAW_BASE = REPO
  ? `https://raw.githubusercontent.com/${REPO}/refs/heads/${BRANCH}/${SKILL_PATH}`
  : "";
export const SKILLS_BLOB_BASE = REPO
  ? `https://github.com/${REPO}/blob/${BRANCH}/${SKILL_PATH}`
  : "";

export const SKILLS = [
  {
    id: "ebrouter",
    name: "ebRouter (Entry)",
    description: "Setup + index of all capabilities. Start here — covers base URL, auth, model discovery, and links to every capability skill.",
    endpoint: null,
    icon: "hub",
    isEntry: true,
  },
  {
    id: "ebrouter-chat",
    name: "Chat",
    description: "Chat / code-gen via OpenAI or Anthropic format with streaming.",
    endpoint: "/v1/chat/completions",
    icon: "chat",
  },
  {
    id: "ebrouter-image",
    name: "Image Generation",
    description: "Text-to-image via DALL-E, Imagen, FLUX, MiniMax, SDWebUI…",
    endpoint: "/v1/images/generations",
    icon: "image",
  },
  {
    id: "ebrouter-tts",
    name: "Text-to-Speech",
    description: "OpenAI / ElevenLabs / Edge / Google / Deepgram voices.",
    endpoint: "/v1/audio/speech",
    icon: "record_voice_over",
  },
  {
    id: "ebrouter-stt",
    name: "Speech-to-Text",
    description: "Transcribe audio via OpenAI Whisper, Groq, Gemini, Deepgram, AssemblyAI…",
    endpoint: "/v1/audio/transcriptions",
    icon: "mic",
  },
  {
    id: "ebrouter-embeddings",
    name: "Embeddings",
    description: "Vectors for RAG / semantic search via OpenAI, Gemini, Mistral…",
    endpoint: "/v1/embeddings",
    icon: "scatter_plot",
  },
  {
    id: "ebrouter-web-search",
    name: "Web Search",
    description: "Tavily / Exa / Brave / Serper / SearXNG / Google PSE / You.com.",
    endpoint: "/v1/search",
    icon: "search",
  },
  {
    id: "ebrouter-web-fetch",
    name: "Web Fetch",
    description: "URL → markdown / text / HTML via Firecrawl, Jina, Tavily, Exa.",
    endpoint: "/v1/web/fetch",
    icon: "language",
  },
];

export function getSkillRawUrl(id) {
  return `/api/skills/${id}`;
}

export function getSkillBlobUrl(id) {
  if (SKILLS_BLOB_BASE) return `${SKILLS_BLOB_BASE}/${id}/SKILL.md`;
  return `/api/skills/${id}`;
}
