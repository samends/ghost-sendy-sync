# Pre-Deployment Checklist

Complete these steps before deploying:

## 1. Update Configuration

- [ ] Edit `lib/spank-sync-stack.ts` line ~49
  - Replace `sam.a.mez@gmail.com` with your email address for failure notifications
  
- [ ] Edit `lib/spank-sync-stack.ts` line ~99  
  - Replace `your-secure-secret-key` with a strong random secret
  - **Generate a secret**: `openssl rand -hex 32` or use a password generator
  - **Save this secret** - you'll need it for Ghost webhook configuration

## 2. Verify Sendy Configuration

- [ ] Check Sendy URL in `lib/spank-sync-stack.ts` line ~85
  - Current: `https://newsletter.khemistryboston.com/sendy`
  
- [ ] Check Sendy API Key in `lib/spank-sync-stack.ts` line ~86
  - Current: `u0m3zvOF6BB2KJTg6cCc`
  
- [ ] Check List IDs in `lib/spank-sync-stack.ts` lines ~87-88
  - General list: `2`
  - Vetted list: `3`

## 3. Build and Test

```bash
# Install dependencies (if not already done)
npm install

# Build the project
npm run build

# Run tests (optional)
npm test
```

- [ ] Build completes without errors
- [ ] Tests pass (optional)

## 4. Deploy to AWS

```bash
# Deploy both CDK stacks
npx cdk deploy --all
```

- [ ] Deployment completes successfully
- [ ] Note the `WebhookEndpointOutput` value from the output
- [ ] Example: `https://abc123xyz.execute-api.us-east-1.amazonaws.com/prod/webhook/member`

## 5. Confirm SNS Email Subscription

- [ ] Check your email inbox for AWS SNS confirmation
- [ ] Click the confirmation link in the email
- [ ] You should see "Subscription confirmed!" in your browser

## 6. Configure Ghost Webhook

Go to Ghost Admin panel:

- [ ] Navigate to **Settings** → **Integrations** → **Custom Integrations**
- [ ] Click **+ Add custom integration**
- [ ] Enter name: `Sendy Sync`
- [ ] Click **Add webhook**
- [ ] Configure webhook:
  - **Name**: `Member Added`
  - **Event**: `Member added`
  - **Target URL**: Paste the `WebhookEndpointOutput` URL from step 4
  - **Secret**: Paste the webhook secret from step 1
- [ ] Click **Save**

## 7. Test the Integration

- [ ] Add a test member in Ghost
  - Email: `test-user@example.com`
  - Name: `Test User`
  
- [ ] Verify in CloudWatch Logs:
  - Go to AWS Console → CloudWatch → Log Groups
  - Find: `/aws/lambda/GhostSendyApiStack-GhostSendyApiLambda*`
  - Check for "Successfully processed member" message
  
- [ ] Verify in DynamoDB:
  - Go to AWS Console → DynamoDB → Tables
  - Open table: `GhostSendyMembers`
  - Check for test member's email in the table
  
- [ ] Verify in Sendy:
  - Log into your Sendy installation
  - Check the appropriate list (general or vetted)
  - Confirm test member is subscribed

## 8. Test Error Handling (Optional)

- [ ] Add a member with "banned" label
  - Check CloudWatch logs for "Skipping banned member"
  - Member should NOT be in Sendy
  
- [ ] Add a member with "vetted" label
  - Check that member goes to vetted list (ID: 3) in Sendy
  
- [ ] Add a member without labels
  - Check that member goes to general list (ID: 2) in Sendy

## 9. Monitor for First Few Days

- [ ] Check CloudWatch Logs daily for errors
- [ ] Monitor your email for failure notifications
- [ ] Verify members are syncing correctly

## Notes

- **Webhook Secret**: Keep this secure! Don't commit to public repos.
- **API Keys**: Consider moving to AWS Secrets Manager for production.
- **Costs**: Should be minimal ($0-5/month for small sites).
- **Rollback**: If issues occur, run `npx cdk destroy --all` to remove everything.

## Support Resources

- [README.md](README.md) - Full documentation
- [DEPLOYMENT.md](DEPLOYMENT.md) - Detailed deployment guide
- [WEBHOOK-REFERENCE.md](WEBHOOK-REFERENCE.md) - Webhook payload details
- [MIGRATION.md](MIGRATION.md) - What changed from previous version

## Troubleshooting

**Build fails:**
- Run `npm install` again
- Check Node.js version (should be 18+)

**Deploy fails:**
- Ensure AWS CLI is configured: `aws configure`
- Check AWS credentials have necessary permissions
- Try: `npx cdk bootstrap` if first time using CDK

**Webhook not firing:**
- Check Ghost webhook configuration
- Verify webhook secret matches
- Check CloudWatch Logs for main Lambda

**Member not syncing:**
- Check Sendy API credentials
- Check CloudWatch Logs for main Lambda
- Check SQS queue for failed messages
