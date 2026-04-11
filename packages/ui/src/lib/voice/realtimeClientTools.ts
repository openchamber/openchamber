import { z } from "zod";
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from "@/stores/useConfigStore";
import { getSyncPermissions } from "@/sync/sync-refs";
import { respondToPermission } from "@/sync/session-actions";

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice agent to interact with Claude Code.
 */
export const realtimeClientTools = {
    /**
     * Send a message to Claude Code via the current session.
     * Validates parameters with Zod and returns status strings.
     */
    messageClaudeCode: async (parameters: unknown): Promise<string> => {
        // Validate parameters with Zod
        const schema = z.object({
            message: z.string().min(1, "Message cannot be empty"),
        });

        const parsed = schema.safeParse(parameters);
        if (!parsed.success) {
            console.error("[Voice] Invalid message parameter:", parsed.error);
            return "error (invalid message parameter)";
        }

        // Get current session ID from store
        const sessionId = useSessionUIStore.getState().currentSessionId;
        if (!sessionId) {
            console.error("[Voice] No active session");
            return "error (no active session)";
        }

        // Get current provider and model from config store
        const { currentProviderId, currentModelId, currentAgentName } = useConfigStore.getState();
        if (!currentProviderId || !currentModelId) {
            console.error("[Voice] No provider/model selected");
            return "error (no provider or model selected)";
        }

        try {
            console.log("[Voice] Sending message to session:", sessionId);
            await useSessionUIStore
                .getState()
                .sendMessage(parsed.data.message, currentProviderId, currentModelId, currentAgentName ?? undefined);
            return "sent";
        } catch (error) {
            console.error("[Voice] Failed to send message:", error);
            return "error (failed to send message)";
        }
    },

    /**
     * Process a permission request from voice.
     * Validates decision with Zod enum and interacts with permission store.
     */
    processPermissionRequest: async (parameters: unknown): Promise<string> => {
        // Validate parameters with Zod
        const schema = z.object({
            decision: z.enum(["allow", "deny"]),
        });

        const parsed = schema.safeParse(parameters);
        if (!parsed.success) {
            console.error("[Voice] Invalid decision parameter:", parsed.error);
            return "error (invalid decision parameter, expected 'allow' or 'deny')";
        }

        // Get current session ID from store
        const sessionId = useSessionUIStore.getState().currentSessionId;
        if (!sessionId) {
            console.error("[Voice] No active session");
            return "error (no active session)";
        }

        // Get pending permissions for this session
        const permissions = getSyncPermissions(sessionId);
        if (!permissions || permissions.length === 0) {
            console.error("[Voice] No pending permission requests");
            return "error (no pending permission request)";
        }

        // Get the first pending permission request
        const request = permissions[0];
        if (!request) {
            return "error (no pending permission request)";
        }

        try {
            const decision = parsed.data.decision;
            console.log(`[Voice] Processing permission request ${request.id}: ${decision}`);

            // Respond to the permission based on decision
            const response: "once" | "always" | "reject" = decision === "allow" ? "once" : "reject";
            await respondToPermission(sessionId, request.id, response);

            return "done";
        } catch (error) {
            console.error("[Voice] Failed to process permission:", error);
            return `error (failed to ${parsed.data.decision} permission)`;
        }
    },
};

/** Type for the realtime client tools */
export type RealtimeClientTools = typeof realtimeClientTools;
