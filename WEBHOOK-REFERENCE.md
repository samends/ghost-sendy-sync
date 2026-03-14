# Ghost Webhook Reference

## Webhook Event: member.added

When a new member is added in Ghost, Ghost sends a POST request to your webhook endpoint.

### Request Format

**Headers:**
```
Content-Type: application/json
X-Ghost-Signature: sha256=<hmac_hex_digest>
```

**Body:**
```json
{
  "member": {
    "current": {
      "id": "member-id-123",
      "uuid": "uuid-456",
      "email": "user@example.com",
      "name": "John Doe",
      "note": null,
      "geolocation": null,
      "subscribed": true,
      "created_at": "2026-03-09T12:00:00.000Z",
      "updated_at": "2026-03-09T12:00:00.000Z",
      "labels": [
        {
          "id": "label-1",
          "name": "vetted",
          "slug": "vetted",
          "created_at": "2025-01-01T00:00:00.000Z",
          "updated_at": "2025-01-01T00:00:00.000Z"
        }
      ],
      "subscriptions": [],
      "newsletters": [],
      "email_count": 0,
      "email_opened_count": 0,
      "email_open_rate": 0,
      "email_click_count": 0,
      "email_click_rate": 0,
      "last_seen_at": null
    }
  }
}
```

## Lambda Handler Processing

The Lambda function:

1. **Extracts member data** from `event.member` or `event.body.member`
2. **Validates** email presence
3. **Checks labels**:
   - If `banned` → skip processing
   - If `vetted` → use vetted Sendy list
   - Otherwise → use general Sendy list
4. **Checks Sendy subscription status**
5. **Subscribes to Sendy** if not already subscribed
6. **Stores in DynamoDB** 
7. **Returns HTTP response**:
   - `200` - Success
   - `400` - Invalid/missing member data
   - `500` - Processing error (triggers alarm)

## API Gateway Response Format

### Success (200)
```json
{
  "success": true,
  "message": "Member processed successfully"
}
```

### Missing Data (400)
```json
{
  "error": "No member data provided"
}
```

or

```json
{
  "error": "Member missing email"
}
```

### Server Error (500)
```json
{
  "error": "Internal server error",
  "details": "Sendy subscription failed: ..."
}
```

## Signature Verification

Ghost signs webhooks using HMAC-SHA256:

```javascript
const crypto = require('crypto');

const signature = crypto
  .createHmac('sha256', webhookSecret)
  .update(JSON.stringify(requestBody))
  .digest('hex');

const expectedHeader = 'sha256=' + signature;
```

The Lambda Authorizer validates this signature.

## Testing Webhook Locally

To test without Ghost, send a POST request:

```bash
curl -X POST https://your-api-gateway-url/webhook/member \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Signature: sha256=<calculated-signature>" \
  -d '{
    "member": {
      "id": "test-123",
      "email": "test@example.com",
      "name": "Test User",
      "subscribed": true,
      "created_at": "2026-03-09T12:00:00.000Z",
      "labels": []
    }
  }'
```

## Configuring Ghost Webhook

1. Go to **Ghost Admin** → **Settings** → **Integrations**
2. Create a **Custom Integration**
3. Add a webhook with:
   - **Event**: `Member added`
   - **Target URL**: Your API Gateway endpoint
   - **Secret**: The webhook secret (matches Lambda env var)

Ghost will automatically:
- Sign requests with the secret
- Send member data when members are added
- Retry on failures (with exponential backoff)

## Monitoring

Check these CloudWatch Log Groups:
- `/aws/lambda/GhostSendyApiStack-GhostSendyApiLambda*` - Main processing

## Common Issues

**401 Unauthorized**
- Webhook secret mismatch between Ghost and Lambda
- Check main Lambda logs

**400 Bad Request**
- Invalid webhook payload format
- Check main Lambda logs for details

**500 Internal Server Error**
- Sendy API error
- DynamoDB error
- Check main Lambda logs
- Check SQS queue for failure details
- Check email for alarm notification
