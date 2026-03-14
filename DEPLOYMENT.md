# Deployment Guide

## Quick Start

### 1. Configure the Stack

Create these SSM Parameter Store parameters before deployment:

```bash
aws ssm put-parameter \
  --name /ghost-sendy-sync/config \
  --type SecureString \
  --value '{"SENDY_API_URL":"https://your-sendy.example.com","SENDY_API_KEY":"replace-with-your-sendy-api-key","SENDY_GENERAL_LIST":"replace-with-your-general-list-id","SENDY_VETTED_LIST":"replace-with-your-vetted-list-id","WEBHOOK_SECRET":"replace-with-your-ghost-webhook-secret"}' \
  --overwrite

aws ssm put-parameter \
  --name /ghost-sendy-sync/failure-notification-email \
  --type String \
  --value 'your-email@example.com' \
  --overwrite

aws ssm put-parameter \
  --name /ghost-signup/config \
  --type SecureString \
  --value '{"SIGNUP_SECRET":"replace-with-a-strong-shared-secret","TURNSTILE_SECRET":"replace-with-your-cloudflare-turnstile-secret","GHOST_ADMIN_TOKEN":"replace-with-your-ghost-admin-token","GHOST_URL":"https://your-ghost-site.example.com"}' \
  --overwrite
```

Optional: override the default parameter names with CDK context:

```bash
npx cdk deploy --all \
  -c ghostSendySyncParameterName=/your/sync/config \
  -c ghostSendyFailureEmailParameterName=/your/sync/failure-email \
  -c ghostSignupParameterName=/your/signup/config
```

### 2. Build and Deploy

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Deploy both stacks to AWS (first time will take 5-10 minutes)
npx cdk deploy --all

# Or deploy only the signup API
npx cdk deploy SignupStack

# Or deploy only the sync stack
npx cdk deploy GhostSendyApiStack
```

### 3. Note the Output

After deployment, save these values:
- `WebhookEndpointOutput`: The API Gateway URL (e.g., `https://abc123.execute-api.us-east-1.amazonaws.com/prod/webhook/member`)
- `SignupStack` resources in CloudFormation/API Gateway: use these to locate the `/signup` endpoint and generated API key if you deploy the signup API

### 4. Configure Ghost Webhook

1. Go to Ghost Admin → **Settings** → **Integrations** → **Custom Integrations**
2. Click **+ Add custom integration**
3. Name it "Sendy Sync" (or any name you prefer)
4. Click **Add webhook**:
   - **Name**: Member Added
   - **Event**: Member added
   - **Target URL**: Paste the `WebhookEndpointOutput` URL
  - **Secret**: Enter the same `WEBHOOK_SECRET` stored in the sync config parameter

### 5. Confirm SNS Email Subscription

1. Check your email for a message from AWS SNS
2. Click the confirmation link
3. You'll now receive notifications if member sync fails

### 6. Test

Add a test member in Ghost and verify:
1. Check CloudWatch Logs: `GhostSendyApiStack-GhostSendyApiLambda*`
2. Check DynamoDB table: `GhostSendyMembers`
3. Check Sendy subscription list

## Updating the Stack

After making changes to the code:

```bash
npm run build
npx cdk deploy --all
```

To update only one stack:

```bash
npx cdk deploy SignupStack
npx cdk deploy GhostSendyApiStack
```

## Rolling Back

To remove all resources:

```bash
npx cdk destroy --all
```

To destroy only one stack:

```bash
npx cdk destroy SignupStack
npx cdk destroy GhostSendyApiStack
```

Note: The DynamoDB table has `RETAIN` policy, so it won't be deleted. Delete manually if needed.

## Environment Variables

The Lambda uses these non-secret environment variables (auto-configured):
- `TABLE_NAME`: DynamoDB table name
- `SYNC_CONFIG_PARAMETER_NAME`: SSM parameter name for sync credentials
- `FAILED_IMPORTS_QUEUE_URL`: SQS queue URL
- `SIGNUP_CONFIG_PARAMETER_NAME`: SSM parameter name for signup credentials

## Security Recommendations

For production:

1. **Keep sensitive config in SSM SecureString parameters** and rotate or update values there instead of editing stack code

2. **Use AWS WAF** to protect the API Gateway endpoint

3. **Enable CloudWatch Logs encryption**

4. **Set up VPC** for Lambda functions if accessing private resources

5. **Enable AWS X-Ray** for distributed tracing

## Cost Estimates

Expected monthly costs (for moderate usage):
- API Gateway: ~$3.50 per million requests
- Lambda: Free tier covers most usage, then $0.20 per 1M requests
- DynamoDB: Free tier (25 GB storage, 25 WCU, 25 RCU)
- SQS: Free tier (1M requests)
- CloudWatch: ~$0.50 for logs
- SNS: $0.50 per million notifications

**Total**: Likely $0-5/month for small sites, $10-20/month for larger sites.
