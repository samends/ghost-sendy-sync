import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export class SignupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const signupConfigParameterName = this.node.tryGetContext("ghostSignupParameterName") ?? "/ghost-signup/config";
    const signupConfigParameterArn = cdk.Stack.of(this).formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: signupConfigParameterName.replace(/^\//, "")
    });

    const signupLambda = new NodejsFunction(this, "SignupLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../lambda/ghostSignUpLambda.ts"),
      handler: "handler",
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      environment: {
        SIGNUP_CONFIG_PARAMETER_NAME: signupConfigParameterName
      }
    });

    signupLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [signupConfigParameterArn]
    }));

    const api = new apigateway.RestApi(this, "SignupApi", {
      restApiName: "Signup Service",
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"]
          })
        ]
      })
    });

    const signup = api.root.addResource("signup");

    const lambdaIntegration = new apigateway.LambdaIntegration(signupLambda);
    signup.addMethod("POST", lambdaIntegration, {
      apiKeyRequired: true
    });

    // ✅ Usage Plan for throttling
    const plan = api.addUsagePlan("SignupUsagePlan", {
      name: "SignupRateLimit",
      throttle: {
        rateLimit: 5, // 5 requests per second
        burstLimit: 10 // max 10 requests at once
      }
    });

    // Create an API key for your Nginx server
    const apiKey = api.addApiKey("SignupApiKey");
    plan.addApiKey(apiKey);
    plan.addApiStage({
      stage: api.deploymentStage
    });

    new cdk.CfnOutput(this, "GhostSignupParameterNameOutput", {
      value: signupConfigParameterName,
      description: "SSM Parameter Store name for signup configuration"
    });
  }
  
}