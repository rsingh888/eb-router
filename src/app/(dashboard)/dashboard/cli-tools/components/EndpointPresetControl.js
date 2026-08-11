"use client";

import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "ebrouter.cliToolEndpointPresets";

function normalizePresets(value) {
  if (!Array.isArray(value)) return [];
  // Persist name + baseUrl only — never store API keys in localStorage.
  return value
    .filter((preset) => preset?.name && preset?.baseUrl)
    .map((preset) => ({ name: String(preset.name), baseUrl: String(preset.baseUrl) }));
}

function readPresets() {
  if (typeof window === "undefined") return [];
  try {
    return normalizePresets(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

function writePresets(presets) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePresets(presets)));
}

export default function EndpointPresetControl({
  baseUrl,
  onBaseUrlChange,
  // apiKey / onApiKeyChange kept for call-site compat; keys are intentionally not persisted.
  apiKey: _apiKey,
  onApiKeyChange: _onApiKeyChange,
}) {
  const [presets, setPresets] = useState([]);
  const [selectedName, setSelectedName] = useState("");

  useEffect(() => {
    setPresets(readPresets());
  }, []);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.name === selectedName) || null,
    [presets, selectedName]
  );

  const handleSelect = (name) => {
    setSelectedName(name);
    const preset = presets.find((item) => item.name === name);
    if (!preset) return;
    onBaseUrlChange(preset.baseUrl);
  };

  const handleSave = () => {
    const trimmedBaseUrl = (baseUrl || "").trim();
    if (!trimmedBaseUrl) return;

    let defaultName = selectedPreset?.name || trimmedBaseUrl;
    try {
      defaultName = selectedPreset?.name || new URL(trimmedBaseUrl).host;
    } catch {
      defaultName = selectedPreset?.name || trimmedBaseUrl;
    }
    const name = window.prompt("Preset name (URL only — API key is not saved)", defaultName);
    if (!name?.trim()) return;

    const nextPreset = { name: name.trim(), baseUrl: trimmedBaseUrl };
    const nextPresets = [
      ...presets.filter((preset) => preset.name !== nextPreset.name),
      nextPreset,
    ].sort((a, b) => a.name.localeCompare(b.name));

    setPresets(nextPresets);
    setSelectedName(nextPreset.name);
    writePresets(nextPresets);
  };

  const handleDelete = () => {
    if (!selectedPreset) return;
    const nextPresets = presets.filter((preset) => preset.name !== selectedPreset.name);
    setPresets(nextPresets);
    setSelectedName("");
    writePresets(nextPresets);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 text-sm font-semibold text-text-main text-right">Preset</span>
      <span className="material-symbols-outlined text-text-muted text-[14px]">arrow_forward</span>
      <select
        value={selectedName}
        onChange={(event) => handleSelect(event.target.value)}
        className="flex-1 px-2 py-1.5 bg-surface rounded text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary/50"
      >
        <option value="">Manual / current endpoint</option>
        {presets.map((preset) => (
          <option key={preset.name} value={preset.name}>
            {preset.name} - {preset.baseUrl}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={handleSave}
        disabled={!baseUrl?.trim()}
        className="px-2 py-1.5 text-xs rounded border border-border bg-surface hover:bg-surface-hover disabled:opacity-50"
      >
        Save
      </button>
      <button
        type="button"
        onClick={handleDelete}
        disabled={!selectedPreset}
        className="px-2 py-1.5 text-xs rounded border border-border bg-surface hover:bg-surface-hover disabled:opacity-50"
      >
        Delete
      </button>
    </div>
  );
}
