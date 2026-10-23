import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { buildApp, loadConfig } from './app';

/** Entry point Lambda sau API Gateway HTTP API (payload v2). Khởi tạo 1 lần mỗi container. */
const app = buildApp(loadConfig());

/** Sự kiện nội bộ: Lambda tự gọi chính nó dạng async để chạy việc nền (AI, ghép tin — QĐ-13). */
interface WorkerEvent {
  source: 'reloop.worker';
  task: 'ai-analysis' | 'listing-matching';
  ref: string;
}

const lambda = new LambdaClient({});
const dispatch = (task: WorkerEvent['task']) => async (ref: string) => {
  const payload: WorkerEvent = { source: 'reloop.worker', task, ref };
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
};
app.services.ai.dispatch = dispatch('ai-analysis');
app.services.listings.dispatchMatching = dispatch('listing-matching');

/** EventBridge rule chạy định kỳ (Epic 10). */
interface ScheduledEvent {
  source: 'aws.events';
  'detail-type': string;
}

export const handler = async (event: APIGatewayProxyEventV2 | WorkerEvent | ScheduledEvent) => {
  if ('source' in event && event.source === 'aws.events') {
    return app.sweeper.sweep();
  }
  if ('source' in event && event.source === 'reloop.worker') {
    if (event.task === 'ai-analysis') await app.services.ai.run(event.ref);
    if (event.task === 'listing-matching') await app.services.listings.matchIfPending(event.ref);
    return;
  }
  return app.handler(event as APIGatewayProxyEventV2);
};
