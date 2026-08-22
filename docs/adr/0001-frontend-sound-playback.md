# 通知音效在前端播放而非通过服务端 SSE 指令下发

OpenChamber 的通知管道由服务端 `packages/web/server/lib/notifications/` 控制（SSE 流 → `handleUiNotificationEvent` → 系统通知）。为加入通知音效，我们评估了两条路径：(A) 服务端在 SSE 事件中附带音效指令，由客户端收到后播放；(B) 前端在 `sync-context.tsx` 的事件处理点直接播放。我们选择了 (B)。

选择前端播放的原因：

- 音效与系统通知生命周期解耦——即使用户关闭了系统通知，音效仍然可以播放。
- 延迟更低（无需经过 SSE → JSON 解析 → 客户端分发）。
- 与 opencode 架构一致（opencode 的 `notification.tsx` 和 `layout.tsx` 全部在前端播放音效）。
- 可见性门控只需 `document.visibilityState`，无需服务端参与。

不选 (A) 的原因：需要修改 `emitter-runtime.js` 的事件格式并在所有投递通道（桌面原生、Web、APNs）上保持语义一致，复杂度高且收益有限。

**Consequences**: 音效播放依赖前端事件流（WebSocket/SSE → `event-pipeline` → `sync-context`）的可靠性；如果前端与服务的连接中断，即使服务端仍在工作，音效也不会播放。系统通知不受影响，因为它是服务端驱动的。
