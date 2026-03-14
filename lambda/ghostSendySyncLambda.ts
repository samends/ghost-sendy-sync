import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb"
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs"
import { createHmac, timingSafeEqual } from 'crypto'

interface GhostLabel {
  id: string
  name: string
  slug: string
  created_at: string
  updated_at: string
}

interface GhostMember {
  id: string
  uuid: string
  email: string
  name: string | null
  note: string | null
  geolocation: string | null
  subscribed: boolean
  created_at: string
  updated_at: string
  labels: GhostLabel[]
  subscriptions: any[]
  newsletters: any[]
  email_count: number
  email_opened_count: number
  email_open_rate: number
  email_click_count: number
  email_click_rate: number
  last_seen_at: string | null
}

interface GhostWebhookMemberEnvelope {
  current?: GhostMember
  previous?: GhostMember
}

interface GhostWebhookPayload {
  member?: GhostWebhookMemberEnvelope
}

interface ApiGatewayLikeEvent {
  body?: string | null
  headers?: Record<string, string>
  isBase64Encoded?: boolean
  [key: string]: unknown
}

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const isGhostMemberEnvelope = (value: unknown): value is GhostWebhookMemberEnvelope => {
  if (!isObject(value)) {
    return false
  }

  return 'current' in value || 'previous' in value
}

interface StoredMember {
  email: string
  name: string
  list: string
  subscribed: boolean
  labels: string[]
  createdAt: string
  updatedAt?: string
}

interface APIGatewayProxyResult {
  statusCode: number
  body: string
}

interface SyncConfig {
  SENDY_API_URL: string
  SENDY_API_KEY: string
  SENDY_GENERAL_LIST: string
  SENDY_VETTED_LIST: string
  WEBHOOK_SECRET: string
}

const dynamoDatabaseClient = new DynamoDBClient({})
const simpleSystemsManagementClient = new SSMClient({})
const simpleQueueServiceClient = new SQSClient({})
let syncConfigPromise: Promise<SyncConfig> | undefined

const getRequiredEnvironmentVariable = (environmentVariableName: string): string => {
  const environmentVariableValue = process.env[environmentVariableName]
  if (!environmentVariableValue) {
    throw new Error(`Missing required environment variable: ${environmentVariableName}`)
  }
  return environmentVariableValue
}

const getConfigStringField = (
  configValues: Record<string, unknown>,
  fieldName: keyof SyncConfig,
  parameterName: string
): string => {
  const fieldValue = configValues[fieldName]

  if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
    throw new Error(`Missing required key ${String(fieldName)} in SSM parameter ${parameterName}`)
  }

  return fieldValue
}

const loadSyncConfig = async (): Promise<SyncConfig> => {
  if (!syncConfigPromise) {
    syncConfigPromise = (async () => {
      const parameterName = getRequiredEnvironmentVariable('SYNC_CONFIG_PARAMETER_NAME')
      const parameterResponse = await simpleSystemsManagementClient.send(
        new GetParameterCommand({ Name: parameterName, WithDecryption: true })
      )

      const parameterValue = parameterResponse.Parameter?.Value

      if (!parameterValue) {
        throw new Error(`SSM parameter ${parameterName} does not contain a value`)
      }

      const parsedConfig = JSON.parse(parameterValue) as Record<string, unknown>

      return {
        SENDY_API_URL: getConfigStringField(parsedConfig, 'SENDY_API_URL', parameterName),
        SENDY_API_KEY: getConfigStringField(parsedConfig, 'SENDY_API_KEY', parameterName),
        SENDY_GENERAL_LIST: getConfigStringField(parsedConfig, 'SENDY_GENERAL_LIST', parameterName),
        SENDY_VETTED_LIST: getConfigStringField(parsedConfig, 'SENDY_VETTED_LIST', parameterName),
        WEBHOOK_SECRET: getConfigStringField(parsedConfig, 'WEBHOOK_SECRET', parameterName)
      }
    })()
  }

  return syncConfigPromise
}

const sendFailureNotification = async (member: any, error: Error | unknown, operation: string = 'process') => {
  const failedImportsQueueAddress = process.env.FAILED_IMPORTS_QUEUE_URL
  if (failedImportsQueueAddress) {
    try {
      await simpleQueueServiceClient.send(new SendMessageCommand({
        QueueUrl: failedImportsQueueAddress,
        MessageBody: JSON.stringify({
          operation,
          email: member.email || 'unknown',
          name: member.name || 'unknown',
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString()
        })
      }))
    } catch (queueError) {
      console.error('Failed to send message to SQS:', queueError)
    }
  }
}

const getMemberFromDynamoDB = async (email: string, tableName: string): Promise<StoredMember | null> => {
  try {
    const result = await dynamoDatabaseClient.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          email: { S: email }
        }
      })
    )

    if (!result.Item) {
      return null
    }

    return {
      email: result.Item.email.S || '',
      name: result.Item.name.S || '',
      list: result.Item.list.S || '',
      subscribed: result.Item.subscribed.BOOL || false,
      labels: result.Item.labels.L?.map((l) => l.S || '') || [],
      createdAt: result.Item.createdAt.S || '',
      updatedAt: result.Item.updatedAt?.S
    }
  } catch (error) {
    console.error('Error fetching from DynamoDB:', error)
    return null
  }
}

const deleteFromSendy = async (
  email: string,
  listId: string,
  sendyApiEndpoint: string,
  sendyApiKey: string
): Promise<void> => {
  console.log(`Deleting ${email} from Sendy list ${listId}`)

  const response = await fetch(`${sendyApiEndpoint}/api/subscribers/delete.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      api_key: sendyApiKey,
      email,
      list_id: listId
    })
  })

  const result = await response.text()
  console.log(`Delete result for list ${listId}: ${result}`)
}

const unsubscribeFromSendy = async (
  email: string,
  listId: string,
  sendyApiEndpoint: string,
  sendyApiKey: string
): Promise<void> => {
  console.log(`Unsubscribing ${email} from Sendy list ${listId}`)

  const response = await fetch(`${sendyApiEndpoint}/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      api_key: sendyApiKey,
      email,
      list: listId
    })
  })

  const result = await response.text()
  console.log(`Unsubscribe result for list ${listId}: ${result}`)
}

const subscribeToSendy = async (
  email: string,
  name: string,
  listId: string,
  sendyApiEndpoint: string,
  sendyApiKey: string
): Promise<void> => {
  console.log(`Subscribing ${email} to Sendy list ${listId}`)

  const response = await fetch(`${sendyApiEndpoint}/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      api_key: sendyApiKey,
      list: listId,
      email,
      name,
    })
  })

  if (!response.ok) {
    throw new Error(`Sendy subscription failed: ${response.statusText}`)
  }

  console.log(`Successfully subscribed ${email} to Sendy list ${listId}`)
}

export function validateGhostSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  console.log("[ghost-webhook] validating signature");

  if (!signatureHeader) {
    console.warn("[ghost-webhook] missing signature header");
    return false;
  }

  console.log("[ghost-webhook] raw header:", signatureHeader);

  const parts = signatureHeader.split(",").map(p => p.trim());

  let signature: string | undefined;
  let timestamp: string | undefined;

  for (const part of parts) {
    const [key, value] = part.split("=");

    if (key === "sha256") signature = value;
    if (key === "t") timestamp = value;
  }

  console.log("[ghost-webhook] parsed signature:", signature);
  console.log("[ghost-webhook] parsed timestamp:", timestamp);

  if (!signature) {
    console.warn("[ghost-webhook] signature missing");
    return false;
  }

  if (!timestamp) {
    console.warn("[ghost-webhook] timestamp missing");
    return false;
  }

  const bodyBuffer =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;

  // Ghost signs raw body bytes concatenated with the timestamp value.
  const signedPayload = Buffer.concat([bodyBuffer, Buffer.from(timestamp, "utf8")]);

  const expectedSignature = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  console.log("[ghost-webhook] expected:", expectedSignature);
  console.log("[ghost-webhook] received:", signature);
  console.log("[ghost-webhook] body bytes:", bodyBuffer.length);
  console.log("[ghost-webhook] signed payload bytes:", signedPayload.length);

  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const receivedBuffer = Buffer.from(signature, "hex");

  if (expectedBuffer.length !== receivedBuffer.length) {
    console.warn("[ghost-webhook] length mismatch");
    return false;
  }

  const valid = timingSafeEqual(expectedBuffer, receivedBuffer);

  if (!valid) {
    console.warn("[ghost-webhook] signature invalid");
  } else {
    console.log("[ghost-webhook] signature valid");
  }

  return valid;
}

export const handler = async (event: ApiGatewayLikeEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Webhook event received:', JSON.stringify(event, null, 2))

    const tableName = getRequiredEnvironmentVariable("TABLE_NAME")
    const {
      SENDY_API_URL: sendyApiEndpoint,
      SENDY_API_KEY: sendyApiKey,
      SENDY_GENERAL_LIST: generalListId,
      SENDY_VETTED_LIST: vettedListId,
      WEBHOOK_SECRET: webhookSecret
    } = await loadSyncConfig()

    // --- Validate webhook signature ---
    const signatureHeader = event.headers?.['X-Ghost-Signature'] || 
                           event.headers?.['x-ghost-signature'] ||
                           ''
    
    // Use the raw body string for signature validation
    const bodyString = event.body || ''

    if (!validateGhostSignature(bodyString, signatureHeader, webhookSecret)) {
      console.log('Webhook signature validation failed')
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized: invalid signature' })
      }
    }

    // --- Parse webhook payload ---
    if (!bodyString) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No request body provided' })
      }
    }

    const payload = JSON.parse(bodyString)
    console.log('Parsed payload structure:', JSON.stringify(payload, null, 2))

    if (!isGhostMemberEnvelope(payload.member)) {
      console.log('Invalid payload: expected member envelope with current/previous')
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid payload: missing member current/previous envelope' })
      }
    }

    const envelope = payload.member
    const currentMember = envelope.current && Object.keys(envelope.current).length > 0 ? envelope.current : null
    const previousMember = envelope.previous && Object.keys(envelope.previous).length > 0 ? envelope.previous : null

    if (!currentMember && !previousMember) {
      console.log('No member.current or member.previous data in payload')
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No member data provided' })
      }
    }

    if (currentMember && previousMember) {
      console.log(`Detected update from envelope for member: ${currentMember.email}`)
      return await handleMemberUpdate(currentMember, previousMember, sendyApiEndpoint, sendyApiKey, generalListId, vettedListId, tableName)
    }

    if (currentMember) {
      console.log(`Detected add from envelope for member: ${currentMember.email}`)
      return await handleMemberAdd(currentMember, sendyApiEndpoint, sendyApiKey, generalListId, vettedListId, tableName)
    }

    if (previousMember) {
      console.log(`Detected delete from envelope for member: ${previousMember.email}`)
      return await handleMemberDelete(previousMember, sendyApiEndpoint, sendyApiKey, generalListId, vettedListId, tableName)
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Could not determine action from member envelope' })
    }
  } catch (error) {
    console.error('Webhook handler error:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error', details: errorMessage })
    }
  }
}

const handleMemberAdd = async (
  member: GhostMember,
  sendyApiEndpoint: string,
  sendyApiKey: string,
  generalListId: string,
  vettedListId: string,
  tableName: string
): Promise<APIGatewayProxyResult> => {
  try {
    const email = member.email
    const name = member.name || ""

    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Member missing email' })
      }
    }

    console.log(`Processing add for member: ${email}`)

    const labels = member.labels ? member.labels.map((label: GhostLabel) => label.name) : []

    // Skip banned members
    if (labels.includes("banned")) {
      console.log("Skipping banned member:", email)
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Banned member skipped' })
      }
    }

    // Determine which list based on labels
    const listId = labels.includes("vetted") ? vettedListId : generalListId

    // Check subscription status in Sendy
    const subscriptionStatusResponse = await fetch(
      `${sendyApiEndpoint}/api/subscribers/subscription-status.php`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          api_key: sendyApiKey,
          email,
          list_id: listId
        })
      }
    )

    const subscriptionStatus = await subscriptionStatusResponse.text()

    // If not subscribed, subscribe them
    if (subscriptionStatus !== "Subscribed") {
      await subscribeToSendy(email, name, listId, sendyApiEndpoint, sendyApiKey)
    } else {
      console.log("Member already subscribed in Sendy:", email)
    }

    // Add member to DynamoDB
    await dynamoDatabaseClient.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          email: { S: email },
          name: { S: name },
          list: { S: listId },
          subscribed: { BOOL: member.subscribed },
          labels: { L: labels.map((label: string) => ({ S: label })) },
          createdAt: { S: member.created_at || new Date().toISOString() }
        }
      })
    )

    console.log(`Successfully processed add for member: ${email}`)
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Member added successfully' })
    }
  } catch (error) {
    console.error('Error in handleMemberAdd:', error)
    await sendFailureNotification(member, error, 'add')
    throw error
  }
}

const handleMemberUpdate = async (
  currentMember: GhostMember,
  previousMember: GhostMember,
  sendyApiEndpoint: string,
  sendyApiKey: string,
  generalListId: string,
  vettedListId: string,
  tableName: string
): Promise<APIGatewayProxyResult> => {
  try {
    const email = currentMember.email
    const name = currentMember.name || ""

    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Member missing email' })
      }
    }

    console.log(`Processing update for member: ${email}`)

    // Compare current and previous state directly from webhook payload.
    const currentLabels = currentMember.labels ? currentMember.labels.map((label: GhostLabel) => label.name) : []
    const previousLabels = previousMember.labels ? previousMember.labels.map((label: GhostLabel) => label.name) : []

    console.log('Update comparison:', {
      previousLabels,
      currentLabels
    })

    // Check if "banned" label was added
    const isBanned = currentLabels.includes("banned")
    const wasBanned = previousLabels.includes("banned")

    if (isBanned && !wasBanned) {
      // Newly banned - unsubscribe from both lists
      console.log(`Member ${email} was banned, unsubscribing from all lists`)
      
      try {
        await unsubscribeFromSendy(email, generalListId, sendyApiEndpoint, sendyApiKey)
      } catch (e) {
        console.warn('Failed to unsubscribe from general list:', e)
      }
      
      try {
        await unsubscribeFromSendy(email, vettedListId, sendyApiEndpoint, sendyApiKey)
      } catch (e) {
        console.warn('Failed to unsubscribe from vetted list:', e)
      }

      // Update DynamoDB
      await dynamoDatabaseClient.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            email: { S: email },
            name: { S: name },
            list: { S: 'banned' },
            subscribed: { BOOL: false },
            labels: { L: currentLabels.map((label: string) => ({ S: label })) },
            createdAt: { S: previousMember.created_at || currentMember.created_at || new Date().toISOString() },
            updatedAt: { S: new Date().toISOString() }
          }
        })
      )

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Member banned and unsubscribed' })
      }
    }

    if (isBanned) {
      // Still banned, no action needed
      console.log(`Member ${email} is still banned, skipping`)
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Member is banned, no action taken' })
      }
    }

    // Check if "vetted" label changed
    const isVetted = currentLabels.includes("vetted")
    const wasVetted = previousLabels.includes("vetted")

    if (isVetted !== wasVetted) {
      // Vetted status changed - need to switch lists
      const newListId = isVetted ? vettedListId : generalListId
      const oldListId = wasVetted ? vettedListId : generalListId

      console.log(`Vetted status changed for ${email}: ${wasVetted} -> ${isVetted}`)
      console.log(`Switching from list ${oldListId} to list ${newListId}`)

      // Unsubscribe from old list
      await unsubscribeFromSendy(email, oldListId, sendyApiEndpoint, sendyApiKey)

      // Subscribe to new list
      await subscribeToSendy(email, name, newListId, sendyApiEndpoint, sendyApiKey)

      // Update DynamoDB
      await dynamoDatabaseClient.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            email: { S: email },
            name: { S: name },
            list: { S: newListId },
            subscribed: { BOOL: currentMember.subscribed },
            labels: { L: currentLabels.map((label: string) => ({ S: label })) },
            createdAt: { S: previousMember.created_at || currentMember.created_at || new Date().toISOString() },
            updatedAt: { S: new Date().toISOString() }
          }
        })
      )

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          success: true, 
          message: `Member moved from ${wasVetted ? 'vetted' : 'general'} to ${isVetted ? 'vetted' : 'general'} list` 
        })
      }
    }

    // No list change, just update member info in DynamoDB
    console.log(`No list change for ${email}, updating member info`)
    
    const listId = isVetted ? vettedListId : generalListId
    
    await dynamoDatabaseClient.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          email: { S: email },
          name: { S: name },
          list: { S: listId },
          subscribed: { BOOL: currentMember.subscribed },
          labels: { L: currentLabels.map((label: string) => ({ S: label })) },
          createdAt: { S: previousMember.created_at || currentMember.created_at || new Date().toISOString() },
          updatedAt: { S: new Date().toISOString() }
        }
      })
    )

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Member updated successfully' })
    }
  } catch (error) {
    console.error('Error in handleMemberUpdate:', error)
    await sendFailureNotification(currentMember, error, 'update')
    throw error
  }
}

const handleMemberDelete = async (
  member: GhostMember,
  sendyApiEndpoint: string,
  sendyApiKey: string,
  generalListId: string,
  vettedListId: string,
  tableName: string
): Promise<APIGatewayProxyResult> => {
  try {
    const email = member.email

    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Member missing email' })
      }
    }

    console.log(`Processing deletion for member: ${email}`)

    // Delete from both Sendy lists
    try {
      await deleteFromSendy(email, generalListId, sendyApiEndpoint, sendyApiKey)
    } catch (error) {
      console.warn(`Failed to delete ${email} from general list:`, error)
    }

    try {
      await deleteFromSendy(email, vettedListId, sendyApiEndpoint, sendyApiKey)
    } catch (error) {
      console.warn(`Failed to delete ${email} from vetted list:`, error)
    }

    // Update DynamoDB to mark as deleted (keeping record for audit trail)
    const storedMember = await getMemberFromDynamoDB(email, tableName)
    
    if (storedMember) {
      await dynamoDatabaseClient.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            email: { S: email },
            name: { S: storedMember.name },
            list: { S: 'deleted' },
            subscribed: { BOOL: false },
            labels: { L: [{ S: 'deleted' }] },
            createdAt: { S: storedMember.createdAt },
            updatedAt: { S: new Date().toISOString() },
            deletedAt: { S: new Date().toISOString() }
          }
        })
      )
    }

    console.log(`Successfully deleted member: ${email}`)
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Member deleted from Sendy' })
    }
  } catch (error) {
    console.error('Error in handleMemberDelete:', error)
    await sendFailureNotification(member, error, 'delete')
    throw error
  }
}

