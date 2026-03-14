import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export class GhostSendyApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const syncConfigParameterName = this.node.tryGetContext('ghostSendySyncParameterName') ?? '/ghost-sendy-sync/config';
    const failureNotificationEmailParameterName =
      this.node.tryGetContext('ghostSendyFailureEmailParameterName') ?? '/ghost-sendy-sync/failure-notification-email';
    const syncConfigParameterArn = cdk.Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: syncConfigParameterName.replace(/^\//, '')
    });

    // --- DynamoDB table for member backup ---
    const memberTable = new dynamodb.Table(this, 'GhostSendyMemberTable', {
      tableName: 'GhostSendyMembers',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // serverless, cheap
      removalPolicy: cdk.RemovalPolicy.RETAIN, // keep data if stack is deleted
    });

    // Optional: add secondary index to query by list type
    memberTable.addGlobalSecondaryIndex({
      indexName: 'list-index',
      partitionKey: { name: 'list', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // --- Failed imports queue ---
    const failedImportsQueue = new sqs.Queue(this, 'FailedImportsQueue', {
      queueName: 'GhostSendyFailedImports',
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.seconds(300)
    });

    const failureNotificationEmail = ssm.StringParameter.valueForStringParameter(
      this,
      failureNotificationEmailParameterName
    );

    // --- SNS topic for email notifications ---
    const failureTopic = new sns.Topic(this, 'FailureNotificationTopic', {
      displayName: 'Ghost/Sendy Import Failures'
    });

    failureTopic.addSubscription(
      new subscriptions.EmailSubscription(failureNotificationEmail)
    );

    // --- CloudWatch Alarm: trigger when queue has messages ---
    const queueAlarm = new cloudwatch.Alarm(this, 'FailedImportsAlarm', {
      metric: failedImportsQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert when failed Ghost/Sendy imports exist'
    });

    queueAlarm.addAlarmAction(new cw_actions.SnsAction(failureTopic));

    // --- Lambda Function ---
    const syncLambda = new NodejsFunction(this, 'GhostSendyApiLambda', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '..', 'lambda', 'ghostSendySyncLambda.ts'),
      handler: 'handler',
      memorySize: 512,
      environment: {
        TABLE_NAME: memberTable.tableName,
        FAILED_IMPORTS_QUEUE_URL: failedImportsQueue.queueUrl,
        SYNC_CONFIG_PARAMETER_NAME: syncConfigParameterName
      },
      timeout: cdk.Duration.seconds(180)
    });

    memberTable.grantReadWriteData(syncLambda);
    failedImportsQueue.grantSendMessages(syncLambda);
    syncLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [syncConfigParameterArn]
    }));

    // --- API Gateway with webhook endpoint ---
    const api = new apigateway.RestApi(this, 'GhostWebhookApi', {
      restApiName: 'Ghost Webhook API',
      description: 'API endpoint for Ghost member webhooks (add, update, delete)',
    });

    // --- Create webhook endpoint ---
    const webhookResource = api.root.addResource('webhook');
    const memberResource = webhookResource.addResource('member');

    memberResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(syncLambda),
      {
        methodResponses: [
          { statusCode: '200', responseModels: { 'application/json': apigateway.Model.EMPTY_MODEL } },
          { statusCode: '400', responseModels: { 'application/json': apigateway.Model.EMPTY_MODEL } },
          { statusCode: '401', responseModels: { 'application/json': apigateway.Model.EMPTY_MODEL } },
          { statusCode: '500', responseModels: { 'application/json': apigateway.Model.EMPTY_MODEL } }
        ]
      }
    );

    // Output the API endpoint for reference
    new cdk.CfnOutput(this, 'WebhookEndpointOutput', {
      value: `${api.url}webhook/member`,
      description: 'Ghost webhook endpoint URL (for member.added, member.updated, member.deleted)',
      exportName: 'GhostWebhookEndpoint'
    });

    new cdk.CfnOutput(this, 'GhostSendySyncParameterNameOutput', {
      value: syncConfigParameterName,
      description: 'SSM Parameter Store name for Ghost/Sendy sync configuration'
    });

    new cdk.CfnOutput(this, 'GhostSendyFailureEmailParameterNameOutput', {
      value: failureNotificationEmailParameterName,
      description: 'SSM Parameter Store name for Ghost/Sendy failure notification email'
    });
  }
}