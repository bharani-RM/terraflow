import os
import boto3
from botocore.exceptions import ClientError
from typing import Dict, List, Any, Optional
from datetime import datetime

def get_boto3_session(access_key: str = "", secret_key: str = "", region: str = "us-east-1"):
    """Creates a boto3 session using explicitly provided credentials or environment variables."""
    access_key = (access_key or os.getenv("AWS_ACCESS_KEY_ID", "")).strip()
    secret_key = (secret_key or os.getenv("AWS_SECRET_ACCESS_KEY", "")).strip()
    region = (region or os.getenv("AWS_DEFAULT_REGION", "us-east-1")).strip()

    if access_key and secret_key:
        return boto3.Session(
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region
        )
    return boto3.Session(region_name=region)

def verify_aws_account(access_key: str = "", secret_key: str = "", region: str = "us-east-1") -> Dict[str, Any]:
    """Verifies AWS credentials using STS GetCallerIdentity and returns account details."""
    try:
        session = get_boto3_session(access_key, secret_key, region)
        sts = session.client("sts")
        identity = sts.get_caller_identity()
        account_id = identity.get("Account", "Unknown")
        arn = identity.get("Arn", "Unknown")
        masked_account = f"{account_id[:4]}****{account_id[-4:]}" if len(account_id) == 12 else account_id
        
        return {
            "success": True,
            "account_id": account_id,
            "masked_account": masked_account,
            "arn": arn,
            "region": region,
            "message": "AWS credentials authenticated successfully."
        }
    except Exception as e:
        return {
            "success": False,
            "account_id": None,
            "masked_account": None,
            "arn": None,
            "region": region,
            "message": f"AWS Authentication Error: {str(e)}"
        }

def reconcile_resource_with_aws(res_type: str, res_id: str, session: boto3.Session) -> Dict[str, Any]:
    """
    Queries AWS APIs directly to verify if a resource exists and gets its real-time AWS state.
    Supports: aws_instance, aws_vpc, aws_subnet, aws_security_group, aws_s3_bucket, aws_lb / aws_alb.
    """
    region = session.region_name or "us-east-1"

    # If res_id is not a real AWS identifier (e.g., config placeholer aws_instance.my_ec2), check if state has real ID
    if not res_id or "." in res_id and not res_id.startswith(("i-", "vpc-", "subnet-", "sg-", "arn:")):
        return {
            "exists": False,
            "status": "NOT_FOUND",
            "display_status": "○ Not Found in AWS",
            "aws_state": "NOT_FOUND",
            "details": "Resource ID not provisioned in AWS"
        }

    try:
        # 1. EC2 Instances
        if res_type == "aws_instance":
            ec2 = session.client("ec2")
            try:
                response = ec2.describe_instances(InstanceIds=[res_id])
                reservations = response.get("Reservations", [])
                if reservations and reservations[0].get("Instances"):
                    inst = reservations[0]["Instances"][0]
                    state_name = inst.get("State", {}).get("Name", "unknown").lower()
                    
                    status_map = {
                        "running": ("RUNNING", "● Running"),
                        "stopped": ("STOPPED", "◐ Stopped"),
                        "stopping": ("STOPPED", "◐ Stopping"),
                        "pending": ("CREATING", "◉ Provisioning"),
                        "shutting-down": ("DELETING", "◌ Terminating"),
                        "terminated": ("DELETED_EXTERNALLY", "○ Deleted externally")
                    }
                    st, disp = status_map.get(state_name, ("UNKNOWN", f"● {state_name.capitalize()}"))
                    exists = state_name not in ["terminated"]
                    
                    return {
                        "exists": exists,
                        "status": st,
                        "display_status": disp,
                        "aws_state": state_name,
                        "details": f"Public IP: {inst.get('PublicIpAddress', 'N/A')}, Type: {inst.get('InstanceType', 't2.micro')}"
                    }
                else:
                    return {
                        "exists": False,
                        "status": "DELETED_EXTERNALLY",
                        "display_status": "○ Deleted externally",
                        "aws_state": "NOT_FOUND",
                        "details": "Resource deleted from AWS Console"
                    }
            except ClientError as ce:
                code = ce.response.get("Error", {}).get("Code", "")
                if code in ["InvalidInstanceID.NotFound", "InvalidInstanceID.Malformed"]:
                    return {
                        "exists": False,
                        "status": "DELETED_EXTERNALLY",
                        "display_status": "○ Deleted externally",
                        "aws_state": "NOT_FOUND",
                        "details": "Instance ID not found in AWS"
                    }
                raise ce

        # 2. VPC
        elif res_type == "aws_vpc":
            ec2 = session.client("ec2")
            try:
                response = ec2.describe_vpcs(VpcIds=[res_id])
                vpcs = response.get("Vpcs", [])
                if vpcs:
                    vpc_state = vpcs[0].get("State", "available")
                    disp = "● Running" if vpc_state == "available" else f"● {vpc_state}"
                    return {
                        "exists": True,
                        "status": "RUNNING" if vpc_state == "available" else "PENDING",
                        "display_status": disp,
                        "aws_state": vpc_state,
                        "details": f"CIDR: {vpcs[0].get('CidrBlock', 'N/A')}"
                    }
                return {
                    "exists": False,
                    "status": "DELETED_EXTERNALLY",
                    "display_status": "○ Deleted externally",
                    "aws_state": "NOT_FOUND",
                    "details": "VPC deleted from AWS Console"
                }
            except ClientError as ce:
                if ce.response.get("Error", {}).get("Code") == "InvalidVpcID.NotFound":
                    return {
                        "exists": False,
                        "status": "DELETED_EXTERNALLY",
                        "display_status": "○ Deleted externally",
                        "aws_state": "NOT_FOUND",
                        "details": "VPC ID not found in AWS"
                    }
                raise ce

        # 3. Subnets
        elif res_type == "aws_subnet":
            ec2 = session.client("ec2")
            try:
                response = ec2.describe_subnets(SubnetIds=[res_id])
                subnets = response.get("Subnets", [])
                if subnets:
                    sub_state = subnets[0].get("State", "available")
                    return {
                        "exists": True,
                        "status": "RUNNING" if sub_state == "available" else "PENDING",
                        "display_status": "● Running" if sub_state == "available" else f"● {sub_state}",
                        "aws_state": sub_state,
                        "details": f"CIDR: {subnets[0].get('CidrBlock', 'N/A')}, AZ: {subnets[0].get('AvailabilityZone', 'N/A')}"
                    }
                return {
                    "exists": False,
                    "status": "DELETED_EXTERNALLY",
                    "display_status": "○ Deleted externally",
                    "aws_state": "NOT_FOUND",
                    "details": "Subnet deleted from AWS Console"
                }
            except ClientError as ce:
                if ce.response.get("Error", {}).get("Code") == "InvalidSubnetID.NotFound":
                    return {
                        "exists": False,
                        "status": "DELETED_EXTERNALLY",
                        "display_status": "○ Deleted externally",
                        "aws_state": "NOT_FOUND",
                        "details": "Subnet ID not found in AWS"
                    }
                raise ce

        # 4. Security Groups
        elif res_type == "aws_security_group":
            ec2 = session.client("ec2")
            try:
                response = ec2.describe_security_groups(GroupIds=[res_id])
                sgs = response.get("SecurityGroups", [])
                if sgs:
                    return {
                        "exists": True,
                        "status": "RUNNING",
                        "display_status": "● Running",
                        "aws_state": "available",
                        "details": f"SG Name: {sgs[0].get('GroupName', 'N/A')}"
                    }
                return {
                    "exists": False,
                    "status": "DELETED_EXTERNALLY",
                    "display_status": "○ Deleted externally",
                    "aws_state": "NOT_FOUND",
                    "details": "Security group deleted from AWS Console"
                }
            except ClientError as ce:
                if ce.response.get("Error", {}).get("Code") in ["InvalidGroup.NotFound", "InvalidGroupId.Malformed"]:
                    return {
                        "exists": False,
                        "status": "DELETED_EXTERNALLY",
                        "display_status": "○ Deleted externally",
                        "aws_state": "NOT_FOUND",
                        "details": "Security Group ID not found in AWS"
                    }
                raise ce

        # 5. S3 Buckets
        elif res_type == "aws_s3_bucket":
            s3 = session.client("s3")
            try:
                s3.head_bucket(Bucket=res_id)
                return {
                    "exists": True,
                    "status": "RUNNING",
                    "display_status": "● Running",
                    "aws_state": "available",
                    "details": f"Bucket Region: {region}"
                }
            except ClientError as ce:
                err_code = str(ce.response.get("Error", {}).get("Code", ""))
                if err_code in ["404", "NoSuchBucket", "NotFound"]:
                    return {
                        "exists": False,
                        "status": "DELETED_EXTERNALLY",
                        "display_status": "○ Deleted externally",
                        "aws_state": "NOT_FOUND",
                        "details": "S3 bucket deleted from AWS Console"
                    }
                elif err_code in ["403", "AccessDenied"]:
                    # Bucket exists but permission restricted
                    return {
                        "exists": True,
                        "status": "RUNNING",
                        "display_status": "● Running (Restricted)",
                        "aws_state": "available",
                        "details": "Bucket exists (Access Restricted)"
                    }
                raise ce

        # 6. Load Balancers
        elif res_type in ["aws_lb", "aws_alb", "aws_elb"]:
            elbv2 = session.client("elbv2")
            try:
                kwargs = {"LoadBalancerArns": [res_id]} if res_id.startswith("arn:") else {"Names": [res_id]}
                response = elbv2.describe_load_balancers(**kwargs)
                lbs = response.get("LoadBalancers", [])
                if lbs:
                    lb_state = lbs[0].get("State", {}).get("Code", "active")
                    return {
                        "exists": True,
                        "status": "RUNNING" if lb_state == "active" else "PENDING",
                        "display_status": "● Running" if lb_state == "active" else f"● {lb_state}",
                        "aws_state": lb_state,
                        "details": f"DNS: {lbs[0].get('DNSName', 'N/A')}"
                    }
                return {
                    "exists": False,
                    "status": "DELETED_EXTERNALLY",
                    "display_status": "○ Deleted externally",
                    "aws_state": "NOT_FOUND",
                    "details": "Load balancer deleted from AWS Console"
                }
            except ClientError as ce:
                if ce.response.get("Error", {}).get("Code") in ["LoadBalancerNotFound", "ValidationError"]:
                    return {
                        "exists": False,
                        "status": "DELETED_EXTERNALLY",
                        "display_status": "○ Deleted externally",
                        "aws_state": "NOT_FOUND",
                        "details": "Load balancer not found in AWS"
                    }
                raise ce

        # Generic fallback for unhandled resource types
        return {
            "exists": True,
            "status": "RUNNING",
            "display_status": "● Running",
            "aws_state": "active",
            "details": f"Resource ID: {res_id}"
        }

    except Exception as err:
        return {
            "exists": True, # Assume true to avoid accidental deletion in case of temporary network error
            "status": "ERROR",
            "display_status": "⚠ AWS Error",
            "aws_state": "ERROR",
            "details": f"Verification error: {str(err)}"
        }

def reconcile_all_resources(
    tracked_resources: List[Dict[str, Any]],
    access_key: str = "",
    secret_key: str = "",
    region: str = "us-east-1"
) -> Dict[str, Any]:
    """
    Reconciles all tracked TerraFlow resources against live AWS environment using boto3 APIs.
    Separates CURRENTLY RUNNING resources from EXTERNALLY DELETED resources.
    """
    session = get_boto3_session(access_key, secret_key, region)
    
    current_running = []
    externally_deleted = []
    reconciled_list = []

    for res in tracked_resources:
        res_type = res.get("type", "")
        res_id = res.get("id", "")
        res_name = res.get("name", "")

        # Call AWS API
        rec = reconcile_resource_with_aws(res_type, res_id, session)

        updated_item = {
            "type": res_type,
            "name": res_name,
            "id": res_id,
            "status": rec["status"],
            "display_status": rec["display_status"],
            "aws_state": rec["aws_state"],
            "details": rec["details"],
            "exists_in_aws": rec["exists"],
            "last_checked": datetime.now().strftime("%I:%M:%S %p")
        }

        reconciled_list.append(updated_item)

        if rec["exists"]:
            current_running.append(updated_item)
        else:
            externally_deleted.append(updated_item)

    is_deployed = len(current_running) > 0

    return {
        "is_deployed": is_deployed,
        "running_count": len(current_running),
        "deleted_count": len(externally_deleted),
        "total_count": len(tracked_resources),
        "current_resources": current_running,
        "externally_deleted_resources": externally_deleted,
        "all_resources": reconciled_list,
        "last_verified_at": datetime.now().isoformat(),
        "last_verified_display": datetime.now().strftime("%Y-%m-%d %I:%M:%S %p")
    }
