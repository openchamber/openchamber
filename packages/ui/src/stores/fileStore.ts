import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { getSafeStorage } from "./utils/safeStorage";
import type { AttachedFile } from "./types/sessionTypes";

interface FileState {
    attachedFiles: AttachedFile[];
}

interface FileActions {
    addAttachedFile: (file: File) => Promise<void>;
    addServerFile: (path: string, name: string, content?: string) => Promise<void>;
    removeAttachedFile: (id: string) => void;
    clearAttachedFiles: () => void;
}

type FileStore = FileState & FileActions;

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;

const guessMimeTypeFromName = (filename: string): string => {
    const name = (filename || "").toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() || "" : "";
    switch (ext) {
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "gif":
            return "image/gif";
        case "webp":
            return "image/webp";
        case "svg":
            return "image/svg+xml";
        case "bmp":
            return "image/bmp";
        case "ico":
            return "image/x-icon";
        case "pdf":
            return "application/pdf";
        default:
            return "application/octet-stream";
    }
};

const guessMimeType = (file: File): string => {
    if (file.type && file.type.trim().length > 0) {
        return file.type;
    }

    const name = (file.name || "").toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() || "" : "";
    const noExtNames = new Set([
        "license",
        "readme",
        "changelog",
        "notice",
        "authors",
        "copying",
    ]);

    if (noExtNames.has(name)) return "text/plain";

    switch (ext) {
        case "md":
        case "markdown":
            return "text/markdown";
        case "txt":
            return "text/plain";
        case "json":
            return "application/json";
        case "yaml":
        case "yml":
            return "application/x-yaml";
        case "ts":
        case "tsx":
        case "js":
        case "jsx":
        case "mjs":
        case "cjs":
        case "py":
        case "rb":
        case "sh":
        case "bash":
        case "zsh":
            return "text/plain";
        default:
            return "application/octet-stream";
    }
};

const normalizeServerPath = (inputPath: string): string => inputPath.replace(/\\/g, "/").trim();

const toFileUrl = (inputPath: string): string => {
    const normalized = normalizeServerPath(inputPath);
    if (normalized.startsWith("file://")) {
        return normalized;
    }

    const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
    return `file://${encodeURI(withLeadingSlash)}`;
};

const readRawFileAsDataUrl = async (absolutePath: string): Promise<string> => {
    const response = await fetch(`/api/fs/raw?path=${encodeURIComponent(absolutePath)}`);
    if (!response.ok) {
        throw new Error(`Failed to read raw file: ${response.status}`);
    }
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

export const useFileStore = create<FileStore>()(

    devtools(
        persist(
            (set, get) => ({

                attachedFiles: [],

                addAttachedFile: async (file: File) => {

                        const { attachedFiles } = get();
                        const isDuplicate = attachedFiles.some((f) => f.filename === file.name && f.size === file.size);
                        if (isDuplicate) {
                            console.log(`File "${file.name}" is already attached`);
                            return;
                        }

                        const maxSize = MAX_ATTACHMENT_SIZE;
                        if (file.size > maxSize) {
                            throw new Error(`File "${file.name}" is too large. Maximum size is 50MB.`);
                        }

                        const allowedTypes = [
                            "text/",
                            "application/json",
                            "application/xml",
                            "application/pdf",
                            "image/",
                            "video/",
                            "audio/",
                            "application/javascript",
                            "application/typescript",
                            "application/x-python",
                            "application/x-ruby",
                            "application/x-sh",
                            "application/yaml",
                            "application/octet-stream",
                        ];

                        const mimeType = guessMimeType(file);
                        const isAllowed = allowedTypes.some((type) => mimeType.startsWith(type) || mimeType === type || mimeType === "");

                        if (!isAllowed && mimeType !== "") {
                            console.warn(`File type "${mimeType}" might not be supported`);
                        }

                        const reader = new FileReader();
                        const rawDataUrl = await new Promise<string>((resolve, reject) => {
                            reader.onload = () => resolve(reader.result as string);
                            reader.onerror = reject;
                            reader.readAsDataURL(file);
                        });

                        const dataUrl = rawDataUrl.startsWith("data:")
                            ? rawDataUrl.replace(/^data:[^;]*/, `data:${mimeType}`)
                            : rawDataUrl;

                        const extractFilename = (fullPath: string) => {

                            const parts = fullPath.replace(/\\/g, "/").split("/");
                            return parts[parts.length - 1] || fullPath;
                        };

                        const attachedFile: AttachedFile = {
                            id: `file-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                            file,
                            dataUrl,
                            mimeType,
                            filename: extractFilename(file.name),
                            size: file.size,
                            source: "local",
                        };

                        set((state) => ({
                            attachedFiles: [...state.attachedFiles, attachedFile],
                        }));
                },

                addServerFile: async (path: string, name: string, content?: string) => {

                        const normalizedPath = normalizeServerPath(path);
                        const { attachedFiles } = get();
                        const isDuplicate = attachedFiles.some((f) => normalizeServerPath(f.serverPath || "") === normalizedPath && f.source === "server");
                        if (isDuplicate) {
                            console.log(`Server file "${name}" is already attached`);
                            return;
                        }

                        const inferredMime = guessMimeTypeFromName(name);
                        const safeMimeType = inferredMime && inferredMime.trim().length > 0 ? inferredMime : "application/octet-stream";

                        const shouldInlineBinary = safeMimeType !== "text/plain" && safeMimeType !== "application/x-directory";

                        let dataUrl = toFileUrl(normalizedPath);
                        if (shouldInlineBinary) {
                            try {
                                dataUrl = await readRawFileAsDataUrl(normalizedPath);
                            } catch (error) {
                                console.warn("Failed to inline binary server file, falling back to file://", error);
                            }
                        }

                        const sizeBytes = typeof content === "string"
                            ? new TextEncoder().encode(content).length
                            : 0;

                        const file = new File([], name, { type: safeMimeType });

                        const attachedFile: AttachedFile = {
                            id: `server-file-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                            file,
                            dataUrl,
                            mimeType: safeMimeType,
                            filename: name,
                            size: sizeBytes,
                            source: "server",
                            serverPath: normalizedPath,
                        };

                        set((state) => ({
                            attachedFiles: [...state.attachedFiles, attachedFile],
                        }));
                },

                removeAttachedFile: (id: string) => {
                    set((state) => ({
                        attachedFiles: state.attachedFiles.filter((f) => f.id !== id),
                    }));
                },

                clearAttachedFiles: () => {
                    set({ attachedFiles: [] });
                },
            }),
            {
                name: "file-store",
                storage: createJSONStorage(() => getSafeStorage()),
                version: 3,
                migrate: (persistedState) => {
                    const state = persistedState as { attachedFiles?: AttachedFile[] } | undefined;
                    return { attachedFiles: Array.isArray(state?.attachedFiles) ? state.attachedFiles : [] };
                },
                // Keep unsent draft attachments across restarts.
                partialize: (state) => ({
                    attachedFiles: state.attachedFiles,
                }),
            }
        ),
        {
            name: "file-store",
        }
    )
);
