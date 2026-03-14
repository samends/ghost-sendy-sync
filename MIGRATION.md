# Migration Summary: EventBridge Timer → Ghost Webhook

## What Changed

### Before (EventBridge Timer)
- Lambda ran on a daily schedule (EventBridge cron)
- Lambda fetched all Ghost members via Ghost Admin API
- Processed all members every day (bulk sync)
- Required Ghost Admin API credentials

### After (Ghost Webhook)
- Lambda triggered by Ghost webhook when member is added
- Processes single member per webhook event (real-time sync)
- No need to fetch from Ghost API
- Webhook validated inside the main Lambda using the raw request body

## Architecture Changes

### Removed
- EventBridge Rule (daily timer)
- Ghost Admin API URL and API Key environment variables
- Bulk member fetching logic
- `GhostApiResponse` interface

### Added
- **API Gateway REST API** with `/webhook/member` endpoint
- In-handler Ghost signature validation in the webhook Lambda
- Webhook event handling interfaces (`GhostWebhookEvent`, `APIGatewayProxyResult`)
- Proper HTTP response codes (200, 400, 401, 500)

### Modified Files

#### `lib/spank-sync-stack.ts`
- Replaced EventBridge imports with API Gateway imports
- Removed EventBridge Rule and Target
- Added API Gateway REST API
- Added webhook endpoint configuration
- Removed Ghost API credentials from environment variables
- Added CloudFormation output for webhook URL

#### `lambda/ghostSendySyncLambda.ts`
- Changed handler signature to accept webhook events
- Returns API Gateway proxy result (HTTP responses)
- Processes single member instead of array of members
- Improved error handling with proper HTTP status codes
- Extracts member from webhook payload
- Validates member data before processing
- Throws errors instead of swallowing them (for proper alarm triggering)

## Security Improvements

1. **Webhook signature validation**: Validates webhook signatures before processing
2. **Removed scheduled polling**: No more periodic API calls to Ghost
3. **Event-driven**: Only processes when actual member additions occur
4. **Better error handling**: Failures properly trigger alarms

## Benefits

1. **Real-time sync**: Members sync immediately when added, not once per day
2. **Cost reduction**: No scheduled Lambda runs, only when members are added
3. **Better security**: Webhook signature validation
4. **Reduced API calls**: No more bulk fetching from Ghost API
5. **Scalability**: Handles member additions as they happen
6. **Cleaner permissions**: No need for Ghost Admin API credentials

## Migration Steps for Existing Deployments

1. **Before deploying**, update configuration:
   - Set email notification address in stack
   - Set webhook secret in the main webhook Lambda

2. **Deploy the stack**:
   ```bash
   npx cdk deploy --all
   ```

3. **Configure Ghost webhook**:
   - Add custom integration in Ghost Admin
   - Create webhook for "member.added" event
   - Use the output URL from CDK deployment
   - Set the same webhook secret

4. **Test**:
   - Add a test member in Ghost
   - Verify in CloudWatch Logs
   - Check DynamoDB and Sendy

5. **Clean up** (optional):
   - Remove Ghost Admin API credentials from AWS if stored elsewhere

## Rollback Plan

If you need to rollback:

1. Keep the old code in a separate branch
2. Redeploy the old stack with EventBridge
3. Remove the Ghost webhook configuration

## Testing Checklist

- [ ] Deploy stack successfully
- [ ] Note webhook URL from outputs
- [ ] Configure Ghost webhook with correct URL and secret
- [ ] Add test member in Ghost
- [ ] Verify Lambda execution in CloudWatch
- [ ] Check member appears in DynamoDB
- [ ] Check member subscribed in Sendy
- [ ] Test banned member (should skip)
- [ ] Test vetted member (should go to vetted list)
- [ ] Test failure scenario (verify alarm triggers)

## Documentation

- [README.md](README.md): Updated with webhook architecture
- [DEPLOYMENT.md](DEPLOYMENT.md): Step-by-step deployment guide
- Repository memory updated with new architecture details
