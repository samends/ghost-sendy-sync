# Ghost to Sendy Sync via Webhook

This CDK project sets up an AWS infrastructure to automatically sync Ghost members to Sendy email lists via webhook triggers.

## Architecture

- **API Gateway**: Exposes a secure webhook endpoint for Ghost
- **Lambda Authorizer**: Validates incoming webhook requests from Ghost
- **Sync Lambda**: Processes new member additions by:
  - Checking if member is already subscribed in Sendy
  - Subscribing member to Sendy if not already subscribed
  - Storing member data in DynamoDB
  - Triggering failure alarms if errors occur
- **DynamoDB**: Stores member data for backup
- **SQS + SNS**: Handles failure notifications via email
- **CloudWatch Alarm**: Triggers when failed imports are detected

## How It Works

1. When a new member is added in Ghost, Ghost sends a webhook to the API Gateway endpoint
2. The Lambda Authorizer validates the request (using X-Ghost-Signature header)
3. The Sync Lambda receives the member data and:
   - Skips members with the "banned" label
   - Determines the correct Sendy list (general or vetted based on labels)
   - Checks if the member is already subscribed in Sendy
   - Subscribes the member if needed
   - Stores the member data in DynamoDB
4. If any errors occur, a message is sent to SQS which triggers a CloudWatch alarm and email notification

## Prerequisites

- AWS CLI configured
- Node.js and npm installed
- AWS CDK CLI installed (`npm install -g aws-cdk`)
- Existing AWS Systems Manager Parameter Store parameters for the Lambda configuration

## Configuration

Before deploying, create the required SSM parameters.

1. **Sync stack config parameter**:
   - Create a secure string parameter named `/ghost-sendy-sync/config` with this JSON payload:
   ```json
   {
     "SENDY_API_URL": "https://your-sendy.example.com",
     "SENDY_API_KEY": "replace-with-your-sendy-api-key",
     "SENDY_GENERAL_LIST": "replace-with-your-general-list-id",
     "SENDY_VETTED_LIST": "replace-with-your-vetted-list-id",
     "WEBHOOK_SECRET": "replace-with-your-ghost-webhook-secret"
   }
   ```
2. **Failure notification email parameter**:
   - Create a standard string parameter named `/ghost-sendy-sync/failure-notification-email`
   - Set its value to the email address that should receive SNS notifications
3. **Signup stack config parameter**:
   - Create a secure string parameter named `/ghost-signup/config` with this JSON payload:
   ```json
   {
     "SIGNUP_SECRET": "replace-with-a-strong-shared-secret",
     "TURNSTILE_SECRET": "replace-with-your-cloudflare-turnstile-secret",
     "GHOST_ADMIN_TOKEN": "replace-with-your-ghost-admin-token",
     "GHOST_URL": "https://your-ghost-site.example.com"
   }
   ```
4. **Optional parameter name overrides**:
   - If you want different parameter names, deploy with CDK context:
   ```bash
   npx cdk deploy --all \
     -c ghostSendySyncParameterName=/your/sync/config \
     -c ghostSendyFailureEmailParameterName=/your/sync/failure-email \
     -c ghostSignupParameterName=/your/signup/config
   ```

## Deployment

1. Install dependencies:
   ```bash
   npm install
   ```

2. Deploy to AWS:
   ```bash
   npx cdk deploy --all
   ```

3. After deployment, note the **WebhookEndpointOutput** URL from the outputs.

## Setting Up Ghost Webhook

1. Log into your Ghost admin panel
2. Navigate to **Settings → Integrations → Custom Integrations**
3. Click **+ Add custom integration**
4. Give it a name (e.g., "Sendy Sync")
5. Click **Add webhook**:
   - **Name**: Member Added
   - **Event**: Member added
   - **Target URL**: Use the `WebhookEndpointOutput` from CDK deployment
   - **Secret**: Use the same `WEBHOOK_SECRET` stored in the sync config parameter

## Testing

You can test the webhook by adding a new member in Ghost. Check:
- CloudWatch Logs for the Lambda functions
- DynamoDB table for stored member data
- Sendy to verify the member was subscribed
- Your email for any failure notifications

## Member Processing Logic

- Members with the `banned` label are skipped
- Members with the `vetted` label go to the vetted Sendy list
- All other members go to the general Sendy list
- If a member is already subscribed in Sendy, they're only added/updated in DynamoDB

## Useful Commands

* `npm run build`   - Optional: emit JavaScript and declaration files
* `npm run watch`   - Watch for changes and compile
* `npm run test`    - Run Jest unit tests
* `npx cdk deploy --all` - Deploy both stacks to your AWS account/region
* `npx cdk diff`    - Compare deployed stack with current state
* `npx cdk synth`   - Emit the synthesized CloudFormation template
* `npx cdk destroy --all` - Remove all resources from AWS

## Security Notes

- The webhook endpoint validates Ghost's signature inside the main webhook Lambda using the raw request body
- Each stack reads its runtime application configuration from its own SSM secure string parameter
- The SNS notification email is read from a plain SSM string parameter so CloudFormation can use it directly
- Keep the parameter names stable so repeated deploys do not depend on local shell state

## Troubleshooting

**Webhook not working:**
- Check CloudWatch Logs for the main webhook Lambda
- Verify the webhook secret matches between Ghost and the Lambda
- Ensure the API Gateway endpoint URL is correct

**Members not syncing to Sendy:**
- Check CloudWatch Logs for the sync Lambda
- Verify Sendy API credentials are correct
- Check SQS queue for failed import messages

**Email notifications not arriving:**
- Confirm your SNS subscription via the email AWS sends
- Check CloudWatch Alarm state
- Verify SQS queue has messages when failures occur
