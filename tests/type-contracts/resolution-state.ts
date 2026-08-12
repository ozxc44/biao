import type {
  ResolutionAction,
  ResolutionDecisionAction,
  ResolutionStatus,
  TaskRecord,
} from '../../src/types/index.js';

// 该文件由定向 tsc 门禁编译；若 SDK 公共联合落后于服务端状态机会直接失败。
const cancelledStatus: ResolutionStatus = 'cancelled';
const cancelAction: ResolutionAction = 'cancel';
const continueAction: ResolutionAction = 'continue';
const decision: ResolutionDecisionAction = 'continue';
const taskStatus: NonNullable<TaskRecord['resolution_status']> = cancelledStatus;
const taskAction: NonNullable<TaskRecord['resolution_action']> = cancelAction;

void [continueAction, decision, taskStatus, taskAction];
