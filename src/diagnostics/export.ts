import type { DiagnosticsLogger } from './logger';
import type { SessionController } from '../sessions/sessionController';
import { redactText } from './redaction';

export function createRedactedDiagnosticsExport(
  logger: DiagnosticsLogger,
  controller: SessionController | undefined
): Record<string, unknown> {
  return logger.health({
    active: controller
      ? {
          folder: redactText(controller.folder.uri.fsPath),
          folderName: controller.folder.name,
          connectionState: controller.snapshot.connectionState,
          generation: controller.snapshot.generation,
          queue: {
            steering: controller.snapshot.queue.steering.length,
            followUp: controller.snapshot.queue.followUp.length,
          },
          model:
            controller.snapshot.state.model &&
            typeof controller.snapshot.state.model.id === 'string'
              ? {
                  provider: controller.snapshot.state.model.provider,
                  id: controller.snapshot.state.model.id,
                }
              : null,
          thinkingLevel: controller.snapshot.state.thinkingLevel,
          sessionFile:
            typeof controller.snapshot.state.sessionFile === 'string'
              ? redactText(controller.snapshot.state.sessionFile)
              : undefined,
          sessionId: controller.snapshot.state.sessionId,
          sessionName: controller.snapshot.state.sessionName,
          messageCount: controller.snapshot.state.messageCount,
          pendingMessageCount: controller.snapshot.state.pendingMessageCount,
          autoCompactionEnabled: controller.snapshot.state.autoCompactionEnabled,
          lastEventType: controller.snapshot.lastEventType,
          eventHistory: controller.snapshot.eventHistory.slice(-20).map((item) => ({
            type: item.type,
            timestamp: item.timestamp,
          })),
          uiHistory: controller.snapshot.uiHistory.slice(-20).map((item) => ({
            method: item.method,
            timestamp: item.timestamp,
          })),
          diagnostics: controller.snapshot.diagnostics.slice(-20).map((item) => ({
            kind: item.kind,
            timestamp: item.timestamp,
          })),
          stats:
            controller.snapshot.lastSessionStats &&
            typeof controller.snapshot.lastSessionStats === 'object'
              ? controller.snapshot.lastSessionStats
              : undefined,
          restartCount: controller.snapshot.restartCount,
        }
      : null,
  });
}
