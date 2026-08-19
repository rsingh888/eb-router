import { NextResponse } from "next/server";
import { readRepoFile } from "@/lib/repoFiles.js";
import { GITHUB_CONFIG } from "@/shared/constants/config";

export async function GET() {
  const local = await readRepoFile("CHANGELOG.md");
  if (local) {
    return new NextResponse(local, {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const remoteUrl = GITHUB_CONFIG?.changelogUrl;
  if (remoteUrl) {
    try {
      const res = await fetch(remoteUrl, { cache: "no-store" });
      if (res.ok) {
        const text = await res.text();
        return new NextResponse(text, {
          headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    } catch {
      /* fall through */
    }
  }

  return NextResponse.json({ error: "Changelog not available" }, { status: 404 });
}
