// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Aws, RemovalPolicy, aws_glue as glue } from 'aws-cdk-lib';;
import { Construct, DependencyGroup } from 'constructs';
import { IRole, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CallAwsService, EventBridgePutEvents } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Choice, Condition, StateMachine, JsonPath, TaskInput, Map, LogLevel, Pass } from "aws-cdk-lib/aws-stepfunctions";
import { CfnEventBusPolicy, EventBus, IEventBus, Rule } from 'aws-cdk-lib/aws-events';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';

import { DataMeshWorkflowRole } from './data-mesh-workflow-role';
import { LakeFormationS3Location } from '../lake-formation';
import { LakeFormationAdmin } from '../lake-formation';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { DataDomain } from './data-domain';

/**
 * Enum to define access control mode in Lake Formation
 */
export enum LfAccessControlMode {
  NRAC = 'nrac',
  TBAC = 'tbac',
}

/**
 * LF Tag interface
 */
export interface LfTag {
  readonly key: string;
  readonly values: string[];
}

/**
 * Properties for the CentralGovernance Construct
 */
export interface CentralGovernanceProps {
  /**
   * LF tags
   */
  readonly lfTags?: LfTag[];
}

/**
 * This CDK Construct creates a Data Product registration workflow and resources for the Central Governance account.
 * It uses AWS Step Functions state machine to orchestrate the workflow:
 * * creates tables in AWS Glue Data Catalog
 * * shares tables to Data Product owner account (Producer)
 * 
 * This construct also creates an Amazon EventBridge Event Bus to enable communication with Data Domain accounts (Producer/Consumer).
 * 
 * This construct requires to use the default [CDK qualifier](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) generated with the standard CDK bootstrap stack.
 * It ensures the right CDK execution role is used and granted Lake Formation administrator permissions so CDK can create Glue databases when registring a DataDomain.
 * 
 * To register a DataDomain, the following information are required:
 * * The account Id of the DataDomain
 * * The secret ARN for the domain configuration available as a CloudFormation output when creating a {@link DataDomain}
 * 
 * Usage example:
 * ```typescript
 * import { App, Stack } from 'aws-cdk-lib';
 * import { Role } from 'aws-cdk-lib/aws-iam';
 * import { CentralGovernance, LfTag } from 'aws-analytics-reference-architecture';
 * 
 * const exampleApp = new App();
 * const stack = new Stack(exampleApp, 'CentralGovStack');
 * 
 * const tags: LfTag[] = [{key: 'tag1': values:['LfTagValue1', 'LfTagValue2']}]
 * const governance = new CentralGovernance(stack, 'myCentralGov', { tags });
 * 
 * governance.registerDataDomain('Domain1', 'domain1Name', <DOMAIN_CONFIG_SECRET_ARN>);
 * ```
 */
export class CentralGovernance extends Construct {

  public static readonly CENTRAL_BUS_NAME: string = 'central-mesh-bus';
  public static readonly DOMAIN_DATABASE_PREFIX: string = 'data-domain';
  public static readonly DOMAIN_TAG_KEY: string = 'LoB';
  public readonly workflowRole: IRole;
  public readonly eventBus: IEventBus;
  private readonly cdkLfAdmin: LakeFormationAdmin;
  private lfTags: LfTag[] = [];

  /**
   * Construct a new instance of CentralGovernance.
   * @param {Construct} scope the Scope of the CDK Construct
   * @param {string} id the ID of the CDK Construct
   * @param {CentralGovernanceProps} props the CentralGovernance properties
   * @access public
   */

  constructor(scope: Construct, id: string, props?: CentralGovernanceProps) {
    super(scope, id);

    // Event Bridge event bus for the Central Governance account
    this.eventBus = new EventBus(this, 'centralEventBus', {
      eventBusName: CentralGovernance.CENTRAL_BUS_NAME,
    });
    this.eventBus.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.cdkLfAdmin = LakeFormationAdmin.addCdkExecRole(scope, 'CdkLfAdmin');

    // Create LF tags in Central Governance account
    if (props) {
      if (props.lfTags) {
        this.lfTags = props.lfTags;
        this.lfTags.forEach(tag =>
          new lakeformation.CfnTag(this, `CentralLfTag${tag.key}`, {
            tagKey: tag.key,
            tagValues: tag.values,
          }).node.addDependency(this.cdkLfAdmin)
        );
      }
    }

    // Workflow role used by the state machine
    this.workflowRole = new DataMeshWorkflowRole(this, 'WorkflowRole').role;

    this.workflowRole.attachInlinePolicy(new Policy(this, 'sendEvents', {
      statements: [
        new PolicyStatement({
          actions: ['events:Put*'],
          resources: [this.eventBus.eventBusArn],
        }),
      ],
    }));

    // Task to create a table
    const createTable = new CallAwsService(this, 'createTable', {
      service: 'glue',
      action: 'createTable',
      iamResources: ['*'],
      parameters: {
        'DatabaseName.$': `States.Format('{}-${CentralGovernance.DOMAIN_DATABASE_PREFIX}-{}', $.lf_access_mode, $.producer_acc_id)`,
        'TableInput': {
          'Name.$': '$.tables.name',
          'Owner.$': '$.producer_acc_id',
          'StorageDescriptor': {
            'Location.$': '$.tables.location'
          }
        },
      },
      resultPath: JsonPath.DISCARD,
    });

    // Grant SUPER permissions (and grantable) on product database and tables to Data Domain account
    const grantTablePermissions = new CallAwsService(this, 'grantTablePermissionsToProducer', {
      service: 'lakeformation',
      action: 'grantPermissions',
      iamResources: ['*'],
      parameters: {
        'Permissions': [
          "ALL"
        ],
        'PermissionsWithGrantOption': [
          'ALL'
        ],
        'Principal': {
          'DataLakePrincipalIdentifier.$': '$.producer_acc_id'
        },
        'Resource': {
          'Table': {
            'DatabaseName.$': `States.Format('{}-${CentralGovernance.DOMAIN_DATABASE_PREFIX}-{}', $.lf_access_mode ,$.producer_acc_id)`,
            'Name.$': '$.tables.name',
          },
        },
      },
      outputPath: '$.tables.name',
      resultPath: JsonPath.DISCARD
    });

    // Trigger workflow in Data Domain account via Event Bridge
    const triggerProducer = new EventBridgePutEvents(this, 'triggerCreateResourceLinks', {
      entries: [{
        detail: TaskInput.fromObject({
          'central_database_name': JsonPath.format(
            "{}-{}-{}",
            JsonPath.stringAt("$.lf_access_mode"),
            CentralGovernance.DOMAIN_DATABASE_PREFIX,
            JsonPath.stringAt("$.producer_acc_id")
          ),
          'central_account_id': Aws.ACCOUNT_ID,
          'producer_acc_id': JsonPath.stringAt("$.producer_acc_id"),
          'database_name': JsonPath.format(
            "{}-{}",
            JsonPath.stringAt("$.lf_access_mode"),
            CentralGovernance.DOMAIN_DATABASE_PREFIX,
          ),
          'table_names': JsonPath.stringAt("$.map_result.flatten"),
          'lf_access_mode': JsonPath.stringAt("$.lf_access_mode"),
        }),
        detailType: JsonPath.format(
          "{}_createResourceLinks",
          JsonPath.stringAt("$.producer_acc_id")
        ),
        eventBus: this.eventBus,
        source: 'com.central.stepfunction'
      }]
    });

    // Iterate over multiple tables in parallel
    const tablesMapTask = new Map(this, 'forEachTable', {
      itemsPath: '$.tables',
      parameters: {
        'producer_acc_id.$': '$.producer_acc_id',
        'tables.$': '$$.Map.Item.Value',
        'lf_access_mode.$': '$.lf_access_mode',
      },
      resultSelector: {
        'flatten.$': '$[*]'
      },
      resultPath: '$.map_result',
    });

    // Check if LF access mode is NRAC
    const checkModeTask = new Choice(this, 'isModeNRAC')
      .when(Condition.stringEquals('$.lf_access_mode', LfAccessControlMode.NRAC), grantTablePermissions)
      .otherwise(new Pass(this, 'Pass', {
        outputPath: '$.tables.name',
        resultPath: JsonPath.DISCARD
      }));

    tablesMapTask.iterator(
      createTable.addCatch(checkModeTask, {
        errors: ['Glue.AlreadyExistsException'],
        resultPath: '$.CreateTableException',
      }).next(checkModeTask),
    );
    tablesMapTask.next(triggerProducer);

    // Create Log group for this state machine
    const logGroup = new LogGroup(this, 'centralGov-stateMachine', {
      retention: RetentionDays.ONE_WEEK,
      logGroupName: '/aws/vendedlogs/data-mesh/workflow',
    });
    logGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // State machine to register data product from Data Domain
    new StateMachine(this, 'RegisterDataProduct', {
      definition: tablesMapTask,
      role: this.workflowRole,
      logs: {
        destination: logGroup,
        level: LogLevel.ALL,
      },
    });
  }

  /**
   * Registers a new Data Domain account in Central Governance account.
   * Each Data Domain account {@link DataDomain} has to be registered in Central Gov. account before it can participate in a mesh.
   * 
   * It creates:
   * * A cross-account policy for Amazon EventBridge Event Bus to enable Data Domain to send events to Central Gov. account
   * * A Lake Formation data access role scoped down to the data domain products bucket
   * * A Glue Catalog Database to hold Data Products for this Data Domain
   * * A Rule to forward events to target Data Domain account.
   * 
   * Object references are passed from the DataDomain account to the CentralGovernance account via a AWS Secret Manager secret and cross account access.
   * It includes the following JSON object:
   * ```json
   * {
   *   BucketName: 'clean-<ACCOUNT_ID>-<REGION>',
   *   Prefix: 'data-products',
   *   KmsKeyId: '<KMS_ID>,
   * }
   * ```
   * 
   * @param {string} id the ID of the CDK Construct
   * @param {string} domainId the account ID of the DataDomain to register
   * @param {string} domainName the name of the DataDomain, i.e. Line of Business name
   * @param {string} domainSecretArn the full ARN of the secret used by producers to share references with the central governance
   * @param {LfAccessControlMode} lfAccessControlMode Lake Formation Access Control mode for the DataDomain
   * @access public
   */
  public registerDataDomain(id: string, domainId: string, domainName: string, domainSecretArn: string, lfAccessControlMode?: LfAccessControlMode) {

    // Import the data domain secret from it's full ARN
    const domainSecret = Secret.fromSecretCompleteArn(this, `${id}DomainSecret`, domainSecretArn);
    // Extract data domain references
    const domainBucket = domainSecret.secretValueFromJson('BucketName').unsafeUnwrap();
    const domainPrefix = domainSecret.secretValueFromJson('Prefix').unsafeUnwrap();
    const domainKey = domainSecret.secretValueFromJson('KmsKeyId').unsafeUnwrap();
    // Construct domain event bus ARN
    const dataDomainBusArn = `arn:aws:events:${Aws.REGION}:${domainId}:event-bus/${DataDomain.DOMAIN_BUS_NAME}`;

    const lfModes = lfAccessControlMode ? [lfAccessControlMode] : [LfAccessControlMode.NRAC, LfAccessControlMode.TBAC];
    lfModes.forEach(mode => {
      // Create the database in Glue with datadomain mode+prefix+bucket, and metadata parameters
      new glue.CfnDatabase(this, `${id}DataDomainDatabase-${mode}`, {
        catalogId: Aws.ACCOUNT_ID,
        databaseInput: {
          description: `Database for data products in ${domainName} data domain. Account id: ${domainId}. LF Access Control mode: ${mode}`,
          name: mode + '-' + CentralGovernance.DOMAIN_DATABASE_PREFIX + '-' + domainId,
          locationUri: `s3://${domainBucket}/${domainPrefix}`,
          parameters: {
            'data_owner': domainId,
            'data_owner_name': domainName,
            'pii_flag': false,
            'access_mode': mode,
          }
        }
      }).node.addDependency(this.cdkLfAdmin);

      // Grant workflow role permissions to domain database
      new lakeformation.CfnPrincipalPermissions(this, `${id}WorkflowRoleDbAccess-${mode}`, {
        permissions: ['ALL'],
        permissionsWithGrantOption: [],
        principal: {
          dataLakePrincipalIdentifier: this.workflowRole.roleArn,
        },
        resource: {
          database: {
            catalogId: Aws.ACCOUNT_ID,
            name: mode + '-' + CentralGovernance.DOMAIN_DATABASE_PREFIX + '-' + domainId,
          }
        },
      }).node.addDependency(this.node.findChild(`${id}DataDomainDatabase-${mode}`));
    });

    // register the S3 location in Lake Formation and create data access role
    new LakeFormationS3Location(this, `${id}LFLocation`, {
      s3Location: {
        bucketName: domainBucket,
        objectKey: domainPrefix,
      },
      accountId: domainId,
      kmsKeyId: domainKey,
    });

    if (lfModes.includes(LfAccessControlMode.TBAC)) {
      const mode = LfAccessControlMode.TBAC;
      // Create LF tag for data domain
      new lakeformation.CfnTag(this, `${id}LfTag`, {
        tagKey: CentralGovernance.DOMAIN_TAG_KEY,
        tagValues: [domainName],
      }).node.addDependency(this.node.findChild(`${id}DataDomainDatabase-${mode}`));

      // Associate LF tag with data domain database
      new lakeformation.CfnTagAssociation(this, `${id}DbTagAssoc`, {
        resource: {
          database: {
            catalogId: Aws.ACCOUNT_ID,
            name: mode + '-' + CentralGovernance.DOMAIN_DATABASE_PREFIX + '-' + domainId,
          }
        },
        lfTags: [
          {
            catalogId: Aws.ACCOUNT_ID,
            tagKey: CentralGovernance.DOMAIN_TAG_KEY,
            tagValues: [domainName],
          }
        ],
      }).node.addDependency(this.node.findChild(`${id}LfTag`));

      // share data domain tag with domainId account
      new lakeformation.CfnPrincipalPermissions(this, `grantDataDomainTag`, {
        permissions: ['ASSOCIATE'],
        permissionsWithGrantOption: ['ASSOCIATE'],
        principal: {
          dataLakePrincipalIdentifier: domainId,
        },
        resource: {
          lfTag: {
            catalogId: Aws.ACCOUNT_ID,
            tagKey: CentralGovernance.DOMAIN_TAG_KEY,
            tagValues: [domainName]
          }
        },
      }).node.addDependency(this.node.findChild(`${id}LfTag`));

      // create LF tag policy for table resource
      new lakeformation.CfnPrincipalPermissions(this, `LFPolicyTable`, {
        permissions: ['ALL'],
        permissionsWithGrantOption: ['ALL'],
        principal: {
          dataLakePrincipalIdentifier: domainId,
        },
        resource: {
          lfTagPolicy: {
            catalogId: Aws.ACCOUNT_ID,
            resourceType: 'TABLE',
            expression: [{
              tagKey: CentralGovernance.DOMAIN_TAG_KEY,
              tagValues: [domainName]
            }]
          }
        },
      }).node.addDependency(this.node.findChild(`${id}LfTag`));

      // create LF tag policy for database resource
      new lakeformation.CfnPrincipalPermissions(this, `LFPolicyDatabase`, {
        permissions: ['CREATE_TABLE', 'DESCRIBE'],
        permissionsWithGrantOption: ['CREATE_TABLE', 'DESCRIBE'],
        principal: {
          dataLakePrincipalIdentifier: domainId,
        },
        resource: {
          lfTagPolicy: {
            catalogId: Aws.ACCOUNT_ID,
            resourceType: 'DATABASE',
            expression: [{
              tagKey: CentralGovernance.DOMAIN_TAG_KEY,
              tagValues: [domainName]
            }]
          }
        },
      }).node.addDependency(this.node.findChild(`${id}LfTag`));

      if (this.lfTags) {
        var shareTagsDependency = new DependencyGroup();
        this.lfTags.forEach(tag => shareTagsDependency.add(this.node.findChild(`CentralLfTag${tag.key}`)));
        // Share all tags with domainId account
        this.lfTags.forEach(tag => {
          new lakeformation.CfnPrincipalPermissions(this, `grantDataDomainTag${tag.key}`, {
            permissions: ['ASSOCIATE'],
            permissionsWithGrantOption: ['ASSOCIATE'],
            principal: {
              dataLakePrincipalIdentifier: domainId,
            },
            resource: {
              lfTag: {
                catalogId: Aws.ACCOUNT_ID,
                tagKey: tag.key,
                tagValues: tag.values
              }
            },
          }).node.addDependency(shareTagsDependency);
        });
      }
    }
    // Cross-account policy to allow Data Domain account to send events to Central Gov. account event bus
    new CfnEventBusPolicy(this, `${domainName}Policy`, {
      eventBusName: this.eventBus.eventBusName,
      statementId: `AllowDataDomainAccToPutEvents_${domainId}`,
      action: 'events:PutEvents',
      principal: domainId,
    });

    // Event Bridge Rule to trigger createResourceLinks workflow in target Data Domain account
    const rule = new Rule(this, `${id}Rule`, {
      eventPattern: {
        source: ['com.central.stepfunction'],
        detailType: [`${domainId}_createResourceLinks`],
      },
      eventBus: this.eventBus,
    });

    rule.addTarget(new targets.EventBus(
      EventBus.fromEventBusArn(
        this,
        `${id}DomainEventBus`,
        dataDomainBusArn
      )),
    );
    rule.applyRemovalPolicy(RemovalPolicy.DESTROY);
  }
}