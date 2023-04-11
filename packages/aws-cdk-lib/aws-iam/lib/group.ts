import { Annotations, ArnFormat, Lazy, Resource, Stack } from '../../core';
import { Construct } from 'constructs';
import { CfnGroup } from './iam.generated';
import { IIdentity } from './identity-base';
import { IManagedPolicy } from './managed-policy';
import { Policy } from './policy';
import { PolicyStatement } from './policy-statement';
import { AddToPrincipalPolicyResult, ArnPrincipal, IPrincipal, PrincipalPolicyFragment } from './principals';
import { AttachedPolicies } from './private/util';
import { IUser } from './user';

/**
 * Represents an IAM Group.
 *
 * @see https://docs.aws.amazon.com/IAM/latest/UserGuide/id_groups.html
 */
export interface IGroup extends IIdentity {
  /**
   * Returns the IAM Group Name
   *
   * @attribute
   */
  readonly groupName: string;

  /**
   * Returns the IAM Group ARN
   *
   * @attribute
   */
  readonly groupArn: string;
}

/**
 * Properties for defining an IAM group
 */
export interface GroupProps {
  /**
   * A name for the IAM group. For valid values, see the GroupName parameter
   * for the CreateGroup action in the IAM API Reference. If you don't specify
   * a name, AWS CloudFormation generates a unique physical ID and uses that
   * ID for the group name.
   *
   * If you specify a name, you must specify the CAPABILITY_NAMED_IAM value to
   * acknowledge your template's capabilities. For more information, see
   * Acknowledging IAM Resources in AWS CloudFormation Templates.
   *
   * @default Generated by CloudFormation (recommended)
   */
  readonly groupName?: string;

  /**
   * A list of managed policies associated with this role.
   *
   * You can add managed policies later using
   * `addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName(policyName))`.
   *
   * @default - No managed policies.
   */
  readonly managedPolicies?: IManagedPolicy[];

  /**
   * The path to the group. For more information about paths, see [IAM
   * Identifiers](http://docs.aws.amazon.com/IAM/latest/UserGuide/index.html?Using_Identifiers.html)
   * in the IAM User Guide.
   *
   * @default /
   */
  readonly path?: string;
}

abstract class GroupBase extends Resource implements IGroup {
  public abstract readonly groupName: string;
  public abstract readonly groupArn: string;

  public readonly grantPrincipal: IPrincipal = this;
  public readonly principalAccount: string | undefined = this.env.account;
  public readonly assumeRoleAction: string = 'sts:AssumeRole';

  private readonly attachedPolicies = new AttachedPolicies();
  private defaultPolicy?: Policy;

  public get policyFragment(): PrincipalPolicyFragment {
    return new ArnPrincipal(this.groupArn).policyFragment;
  }

  /**
   * Attaches a policy to this group.
   * @param policy The policy to attach.
   */
  public attachInlinePolicy(policy: Policy) {
    this.attachedPolicies.attach(policy);
    policy.attachToGroup(this);
  }

  public addManagedPolicy(_policy: IManagedPolicy) {
    // drop
  }

  /**
   * Adds a user to this group.
   */
  public addUser(user: IUser) {
    user.addToGroup(this);
  }

  /**
   * Adds an IAM statement to the default policy.
   */
  public addToPrincipalPolicy(statement: PolicyStatement): AddToPrincipalPolicyResult {
    if (!this.defaultPolicy) {
      this.defaultPolicy = new Policy(this, 'DefaultPolicy');
      this.defaultPolicy.attachToGroup(this);
    }

    this.defaultPolicy.addStatements(statement);
    return { statementAdded: true, policyDependable: this.defaultPolicy };
  }

  public addToPolicy(statement: PolicyStatement): boolean {
    return this.addToPrincipalPolicy(statement).statementAdded;
  }
}

/**
 * An IAM Group (collection of IAM users) lets you specify permissions for
 * multiple users, which can make it easier to manage permissions for those users.
 *
 * @see https://docs.aws.amazon.com/IAM/latest/UserGuide/id_groups.html
 */
export class Group extends GroupBase {
  /**
   * Import an external group by ARN.
   *
   * If the imported Group ARN is a Token (such as a
   * `CfnParameter.valueAsString` or a `Fn.importValue()`) *and* the referenced
   * group has a `path` (like `arn:...:group/AdminGroup/NetworkAdmin`), the
   * `groupName` property will not resolve to the correct value. Instead it
   * will resolve to the first path component. We unfortunately cannot express
   * the correct calculation of the full path name as a CloudFormation
   * expression. In this scenario the Group ARN should be supplied without the
   * `path` in order to resolve the correct group resource.
   *
   * @param scope construct scope
   * @param id construct id
   * @param groupArn the ARN of the group to import (e.g. `arn:aws:iam::account-id:group/group-name`)
   */
  public static fromGroupArn(scope: Construct, id: string, groupArn: string): IGroup {
    const arnComponents = Stack.of(scope).splitArn(groupArn, ArnFormat.SLASH_RESOURCE_NAME);
    const groupName = arnComponents.resourceName!;
    class Import extends GroupBase {
      public groupName = groupName;
      public groupArn = groupArn;
      public principalAccount = arnComponents.account;
    }

    return new Import(scope, id);
  }

  /**
   * Import an existing group by given name (with path).
   * This method has same caveats of `fromGroupArn`
   *
   * @param scope construct scope
   * @param id construct id
   * @param groupName the groupName (path included) of the existing group to import
   */
  static fromGroupName(scope: Construct, id: string, groupName: string) {
    const groupArn = Stack.of(scope).formatArn({
      service: 'iam',
      region: '',
      resource: 'group',
      resourceName: groupName,
    });
    return Group.fromGroupArn(scope, id, groupArn);
  }

  public readonly groupName: string;
  public readonly groupArn: string;

  private readonly managedPolicies: IManagedPolicy[] = [];

  constructor(scope: Construct, id: string, props: GroupProps = {}) {
    super(scope, id, {
      physicalName: props.groupName,
    });

    this.managedPolicies.push(...props.managedPolicies || []);

    const group = new CfnGroup(this, 'Resource', {
      groupName: this.physicalName,
      managedPolicyArns: Lazy.list({ produce: () => this.managedPolicies.map(p => p.managedPolicyArn) }, { omitEmpty: true }),
      path: props.path,
    });

    this.groupName = this.getResourceNameAttribute(group.ref);
    this.groupArn = this.getResourceArnAttribute(group.attrArn, {
      region: '', // IAM is global in each partition
      service: 'iam',
      resource: 'group',
      // Removes leading slash from path
      resourceName: `${props.path ? props.path.substr(props.path.charAt(0) === '/' ? 1 : 0) : ''}${this.physicalName}`,
    });

    this.managedPoliciesExceededWarning();
  }

  /**
   * Attaches a managed policy to this group. See [IAM and AWS STS quotas, name requirements, and character limits]
   * (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html#reference_iam-quotas-entities)
   * for quota of managed policies attached to an IAM group.
   * @param policy The managed policy to attach.
   */
  public addManagedPolicy(policy: IManagedPolicy) {
    if (this.managedPolicies.find(mp => mp === policy)) { return; }
    this.managedPolicies.push(policy);
    this.managedPoliciesExceededWarning();
  }

  private managedPoliciesExceededWarning() {
    if (this.managedPolicies.length > 10) {
      Annotations.of(this).addWarning(`You added ${this.managedPolicies.length} to IAM Group ${this.physicalName}. The maximum number of managed policies attached to an IAM group is 10.`);
    }
  }
}