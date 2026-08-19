"use client";

import { useEffect, useState } from "react";
import { Card, Badge } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  SKILLS,
  SKILLS_REPO_URL,
} from "@/shared/constants/skills";

function skillApiPath(id) {
  return `/api/skills/${id}`;
}

function skillAbsoluteUrl(id) {
  if (typeof window === "undefined") return skillApiPath(id);
  return `${window.location.origin}${skillApiPath(id)}`;
}

function CopyButton({ value, id, label = "Copy link" }) {
  const { copied, copy } = useCopyToClipboard(2000);
  const isCopied = copied === id || copied === "default";
  return (
    <button
      onClick={() => copy(value, id)}
      className="px-2 py-1 rounded-md bg-primary text-white text-[11px] font-medium hover:bg-primary/90 transition-colors cursor-pointer shrink-0 inline-flex items-center gap-1"
      title={value}
    >
      <span className="material-symbols-outlined text-[12px]">
        {isCopied ? "check" : "content_copy"}
      </span>
      {isCopied ? "Copied!" : label}
    </button>
  );
}

function SkillRow({ skill, origin }) {
  const url = origin ? `${origin}${skillApiPath(skill.id)}` : skillApiPath(skill.id);
  const pastePrompt = `Read this skill and use it: ${url}`;
  const { copied, copy } = useCopyToClipboard(2000);
  const [copyingText, setCopyingText] = useState(false);

  const copySkillText = async () => {
    setCopyingText(true);
    try {
      const res = await fetch(skillApiPath(skill.id));
      const text = await res.text();
      if (!res.ok) throw new Error(text || "Failed to load skill");
      copy(text, `${skill.id}-text`);
    } catch {
      copy(pastePrompt, `${skill.id}-text`);
    } finally {
      setCopyingText(false);
    }
  };

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-[14px] border shadow-[var(--shadow-soft)] transition-colors ${
        skill.isEntry
          ? "border-brand-500/40 bg-brand-500/5"
          : "border-border-subtle bg-surface hover:bg-surface-2"
      }`}
    >
      <div
        className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
          skill.isEntry ? "bg-primary text-white" : "bg-primary/10 text-primary"
        }`}
      >
        <span className="material-symbols-outlined text-[18px]">{skill.icon}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-sm text-text-main">{skill.name}</h3>
          {skill.isEntry && (
            <Badge variant="primary" size="sm">START HERE</Badge>
          )}
          {skill.endpoint && (
            <Badge variant="default" size="sm">
              <code className="text-[10px]">{skill.endpoint}</code>
            </Badge>
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5">{skill.description}</p>
        <a
          href={skillApiPath(skill.id)}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-text-muted hover:text-primary mt-1 inline-flex items-center gap-1 break-all"
        >
          {url}
          <span className="material-symbols-outlined text-[12px]">open_in_new</span>
        </a>
      </div>

      <div className="flex flex-col gap-1 shrink-0">
        <CopyButton value={pastePrompt} id={skill.id} />
        <button
          onClick={copySkillText}
          disabled={copyingText}
          className="px-2 py-1 rounded-md border border-border text-[11px] font-medium text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[12px]">
            {copied === `${skill.id}-text` ? "check" : "description"}
          </span>
          {copied === `${skill.id}-text` ? "Copied!" : "Copy text"}
        </button>
      </div>
    </div>
  );
}

export default function SkillsPage() {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const entryUrl = origin ? skillAbsoluteUrl("ebrouter") : skillApiPath("ebrouter");
  const showGithub = SKILLS_REPO_URL && !SKILLS_REPO_URL.includes("YOUR_ORG");

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Card padding="md">
        <div className="text-xs text-text-muted mb-2">Paste this to your AI:</div>
        <div className="px-3 py-2 rounded bg-surface-2 font-mono text-[12px] text-text-main break-all">
          Read this skill and use it: {entryUrl}
        </div>
      </Card>

      <div className="space-y-2">
        {SKILLS.map((skill) => (
          <SkillRow key={skill.id} skill={skill} origin={origin} />
        ))}
      </div>

      {showGithub && (
        <Card padding="md">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-text-main">More on GitHub</h2>
              <p className="text-xs text-text-muted mt-0.5">
                Browse source, README, and examples.
              </p>
            </div>
            <a
              href={`${SKILLS_REPO_URL}/tree/master/skills`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-primary hover:underline inline-flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">open_in_new</span>
              View on GitHub
            </a>
          </div>
        </Card>
      )}
    </div>
  );
}
