import { NextResponse } from "next/server";
import { readRepoFile } from "@/lib/repoFiles.js";
import { SKILLS } from "@/shared/constants/skills";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const SKILL_ID_RE = /^[a-z0-9-]+$/;

function publicOrigin(request) {
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("host") || "localhost:20128";
  return `${proto}://${host}`;
}

function rewriteSkillUrls(markdown, origin) {
  return markdown.replace(
    /https:\/\/raw\.githubusercontent\.com\/[^/\s]+\/[^/\s]+\/refs\/heads\/[^/\s]+\/skills\/([a-z0-9-]+)\/SKILL\.md/g,
    `${origin}/api/skills/$1`
  );
}

export async function GET(request, { params }) {
  const { id } = await params;
  if (!id || !SKILL_ID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid skill id" }, { status: 400, headers: CORS_HEADERS });
  }
  if (!SKILLS.some((s) => s.id === id)) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404, headers: CORS_HEADERS });
  }

  const markdown = await readRepoFile("skills", id, "SKILL.md");
  if (!markdown) {
    return NextResponse.json({ error: "Skill file not found on this server" }, { status: 404, headers: CORS_HEADERS });
  }

  const body = rewriteSkillUrls(markdown, publicOrigin(request));
  return new NextResponse(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
