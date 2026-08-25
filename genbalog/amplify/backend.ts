import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource'

import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Duration } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
export const backend = defineBackend({
  auth,
  data,
  storage
});

const mediaBucket = backend.storage.resources.bucket as Bucket;
mediaBucket.addLifecycleRule({
  id:'genbalog-photo-retention',
  enabled: true,
  prefix: 'media/',
  expiration: Duration.days(30),
  abortIncompleteMultipartUploadAfter: Duration.days(1),
});

const costStack = backend.createStack('cost-guardrails');
const NOTIFY_EMAIL = 't.amahaya@benjamin.co.jp';

new CfnBudget(costStack, 'GenbaLogMonthlyBudget', {
  budget: {
    budgetName: 'GenbaLog-monthly',
    budgetType: 'COST',
    timeUnit: 'MONTHLY',
    budgetLimit: { amount: 10, unit: 'USD' },
  },
  notificationsWithSubscribers: [
    { type: 'ACTUAL', th: 50 },
    { type: 'ACTUAL', th: 80 },
    { type: 'ACTUAL', th: 100 },
    { type: 'FORECASTED', th: 100 },
  ].map((t) => ({
    notification: {
      notificationType: t.type,
      comparisonOperator: 'GREATER_THAN',
      threshold: t.th,
      thresholdType: 'PERCENTAGE',
    },
    subscribers: [{ subscriptionType: 'EMAIL', address: NOTIFY_EMAIL }],
  })),
});