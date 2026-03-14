import GhostAdminAPI from "@tryghost/admin-api";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import validator from "validator";
import { z } from "zod";

interface ApiGatewayLikeEvent {
  body?: string | null;
  headers: Record<string, string | undefined>;
  [key: string]: unknown;
}

interface APIGatewayProxyResult {
  statusCode: number;
  body: string;
}

interface SignUpRequestBody {
  email: string;
  name: string;
  token: string;
}

interface TurnstileVerificationResponse {
  success?: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
}

interface SignupConfig {
  SIGNUP_SECRET: string;
  TURNSTILE_SECRET: string;
  GHOST_ADMIN_TOKEN: string;
  GHOST_URL: string;
}

const simpleSystemsManagementClient = new SSMClient({});
let signupConfigPromise: Promise<SignupConfig> | undefined;

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const getRequiredEnvironmentVariable = (environmentVariableName: string): string => {
  const environmentVariableValue = process.env[environmentVariableName];

  if (!environmentVariableValue) {
    throw new Error(`Missing required environment variable: ${environmentVariableName}`);
  }

  return environmentVariableValue;
};

const getConfigStringField = (
  configValues: Record<string, unknown>,
  fieldName: keyof SignupConfig,
  parameterName: string
): string => {
  const fieldValue = configValues[fieldName];

  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`Missing required key ${String(fieldName)} in SSM parameter ${parameterName}`);
  }

  return fieldValue;
};

const loadSignupConfig = async (): Promise<SignupConfig> => {
  if (!signupConfigPromise) {
    signupConfigPromise = (async () => {
      const parameterName = getRequiredEnvironmentVariable("SIGNUP_CONFIG_PARAMETER_NAME");
      const parameterResponse = await simpleSystemsManagementClient.send(
        new GetParameterCommand({ Name: parameterName, WithDecryption: true })
      );

      const parameterValue = parameterResponse.Parameter?.Value;

      if (!parameterValue) {
        throw new Error(`SSM parameter ${parameterName} does not contain a value`);
      }

      const parsedConfig = JSON.parse(parameterValue) as Record<string, unknown>;

      return {
        SIGNUP_SECRET: getConfigStringField(parsedConfig, "SIGNUP_SECRET", parameterName),
        TURNSTILE_SECRET: getConfigStringField(parsedConfig, "TURNSTILE_SECRET", parameterName),
        GHOST_ADMIN_TOKEN: getConfigStringField(parsedConfig, "GHOST_ADMIN_TOKEN", parameterName),
        GHOST_URL: getConfigStringField(parsedConfig, "GHOST_URL", parameterName)
      };
    })();
  }

  return signupConfigPromise;
};

const normalizeEmailAddress = (value: string): string => {
  const trimmedValue = value.trim();
  const normalizedValue = validator.normalizeEmail(trimmedValue, {
    all_lowercase: true,
    gmail_lowercase: true,
    gmail_remove_dots: false,
    gmail_remove_subaddress: false,
    gmail_convert_googlemaildotcom: false,
    outlookdotcom_lowercase: true,
    outlookdotcom_remove_subaddress: false,
    yahoo_lowercase: true,
    yahoo_remove_subaddress: false,
    icloud_lowercase: true,
    icloud_remove_subaddress: false
  });

  return normalizedValue || trimmedValue.toLowerCase();
};

const normalizeDisplayName = (value: string): string => {
  return value.trim().replace(/\s+/g, " ");
};

const containsControlCharacters = (value: string): boolean => {
  return /[\u0000-\u001F\u007F]/.test(value);
};

const containsHtmlLikeContent = (value: string): boolean => {
  return /<\/?[a-z][^>]*>/i.test(value) || /&(?:lt|gt|#x3c|#x3e|#60|#62);/i.test(value);
};

const isValidEmailAddress = (value: string): boolean => {
  return validator.isEmail(value, {
    allow_utf8_local_part: false,
    require_tld: true
  }) && value.length <= 254;
};

const requiredStringField = z.preprocess((value) => {
  return typeof value === "string" ? value : "";
}, z.string());

const signUpRequestSchema = z.object({
  email: requiredStringField
    .transform(normalizeEmailAddress)
    .refine((value) => value.length > 0, {
      message: "Missing email, name, or captcha token"
    })
    .refine((value) => isValidEmailAddress(value), {
      message: "Invalid email"
    })
    .refine((value) => !containsControlCharacters(value) && !containsHtmlLikeContent(value), {
      message: "Invalid field values"
    }),
  name: requiredStringField
    .transform(normalizeDisplayName)
    .refine((value) => value.length > 0, {
      message: "Missing email, name, or captcha token"
    })
    .refine((value) => !containsControlCharacters(value) && !containsHtmlLikeContent(value), {
      message: "Invalid field values"
    })
    .refine((value) => value.length <= 191, {
      message: "Invalid field values"
    }),
  token: requiredStringField
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      message: "Missing email, name, or captcha token"
    }),
  company: z.string().optional()
});

const escapeGhostFilterValue = (value: string): string => {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
};

const validateTurnstileToken = async (
  token: string,
  secret: string,
): Promise<TurnstileVerificationResponse> => {
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          secret,
          response: token,
        })
      }
    );

    console.log("Turnstile siteverify status", response.status);

    const result: unknown = await response.json();

    console.log("Turnstile siteverify payload", JSON.stringify(result));

    if (!isObject(result)) {
      return {
        success: false,
        "error-codes": ["internal-error"]
      };
    }

    return result as TurnstileVerificationResponse;
  } catch (error) {
    console.error("Turnstile validation error:", error);

    return {
      success: false,
      "error-codes": ["internal-error"]
    };
  }
};

export const handler = async (event: ApiGatewayLikeEvent): Promise<APIGatewayProxyResult> => {

  const {
    SIGNUP_SECRET,
    TURNSTILE_SECRET,
    GHOST_ADMIN_TOKEN,
    GHOST_URL
  } = await loadSignupConfig();
  const ghostAdminApi = new GhostAdminAPI({
    url: GHOST_URL,
    key: GHOST_ADMIN_TOKEN,
    version: "v6.0"
  });

  const headerSecret =
    event.headers["x-signup-secret"] ||
    event.headers["X-Signup-Secret"];

  if (headerSecret !== SIGNUP_SECRET) {
    return {
      statusCode: 403,
      body: "Forbidden"
    };
  }

  if (!event.body) {
    return { statusCode: 400, body: "Missing request body" };
  }

  let requestBody: unknown;

  try {
    requestBody = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      body: "Invalid request body"
    };
  }

  const parsedRequestBody = signUpRequestSchema.safeParse(requestBody);

  if (!parsedRequestBody.success) {
    const validationMessages = parsedRequestBody.error.issues.map((issue) => issue.message);

    return {
      statusCode: 400,
      body: validationMessages.includes("Missing email, name, or captcha token")
        ? "Missing email, name, or captcha token"
        : validationMessages.includes("Invalid email")
          ? "Invalid email"
          : "Invalid field values"
    };
  }

  const {
    email: normalizedEmail,
    name: normalizedName,
    token,
    company: honeyPotField
  } = parsedRequestBody.data;

  if (honeyPotField) {
    return {
      statusCode: 400,
      body: "Bot detected"
    }
  }

  // 1️⃣ Verify Turnstile captcha
  console.log("Starting Turnstile verification", {
    email: normalizedEmail,
    tokenLength: token.length
  });

  const captcha = await validateTurnstileToken(token, TURNSTILE_SECRET);

  console.log("Turnstile validation completed", {
    email: normalizedEmail,
    success: captcha.success,
    errorCodes: captcha["error-codes"],
    hostname: captcha.hostname,
    action: captcha.action
  });

  if (!captcha.success) {
    const errorCodes = captcha["error-codes"]?.join(", ") || "unknown-error";

    console.warn("Turnstile validation failed", {
      email: normalizedEmail,
      errorCodes,
      hostname: captcha.hostname,
      action: captcha.action
    });

    return {
      statusCode: 400,
      body: `Captcha failed: ${errorCodes}`
    };
  }

  // 2️⃣ Check if member already exists in Ghost
  try {
    const memberEmailFilter = `email:'${escapeGhostFilterValue(normalizedEmail)}'`;

    console.log("Checking Ghost for existing member", {
      email: normalizedEmail,
      memberEmailFilter
    });

    const existingMembers = await ghostAdminApi.members.browse({
      limit: 1,
      filter: memberEmailFilter
    });

    console.log("Ghost member lookup completed", {
      email: normalizedEmail,
      existingMemberCount: existingMembers.length
    });

    if (existingMembers.length > 0) {
      console.log("Ghost member already exists", {
        email: normalizedEmail
      });

      return {
        statusCode: 200,
        body: "Member already exists"
      };
    }

    console.log("Creating Ghost member", {
      email: normalizedEmail,
      name: normalizedName
    });

    await ghostAdminApi.members.add({
      email: normalizedEmail,
      name: normalizedName
    });

    console.log("Ghost member created", {
      email: normalizedEmail
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error("Ghost member operation failed", {
      email: normalizedEmail,
      errorMessage,
      error
    });

    return {
      statusCode: 502,
      body: `Ghost API error: ${errorMessage}`
    };
  }

  return {
    statusCode: 200,
    body: "ok"
  };
};