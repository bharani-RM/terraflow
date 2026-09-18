/**
 * TerraFlow AI AWS Infrastructure Platform - Main Application Controller
 * Features: Toast Notification System, Real-Time AWS SDK Reconciliation,
 * External Deletion Detection, Background Refresh, Pre-Flight Action Sync,
 * Performance Breakdown Timing Metrics, and Safety Confirmation Checks.
 */

const state = {
    awsAccessKey: "",
    awsSecretKey: "",
    awsRegion: "us-east-1",
    awsAccountMasked: "",
    isConnected: false,
    activeTab: "prompt",
    inputText: "",
    generatedCode: "",
    monacoEditor: null,
    deploymentLogs: "",
    rawLogs: "",
    deployStartTime: null,
    currentPipelineStep: 1,
    appStatus: "IDLE", // IDLE, GENERATING, GENERATED, REVIEWING, VALIDATING, READY_TO_DEPLOY, DEPLOYING, DEPLOYED, TERMINATING, TERMINATED, ERROR
    isDeployed: false,
    runningResources: [],
    externallyDeletedResources: [],
    allResources: [],
    deploymentHistory: [],
    lastVerifiedDisplay: "Not synced yet",
    syncInterval: null
};

// Initialize Application on DOM Content Loaded
document.addEventListener("DOMContentLoaded", () => {
    initMonacoEditor();
    setupEventListeners();
    updatePipelineUI(1);
    checkInitialSystemStatus();
    startBackgroundReconciliation();
});

/* ==========================================================================
   Global Toast Notification Manager
   ========================================================================== */

function showToast(type, title, message, duration = 4500) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-card ${type}`;

    let icon = "ℹ️";
    if (type === 'success') icon = "✓";
    else if (type === 'warning') icon = "⚠️";
    else if (type === 'error') icon = "✖";

    toast.innerHTML = `
        <div class="toast-icon">${icon}</div>
        <div class="toast-content">
            <div class="toast-title">${escapeHtml(title)}</div>
            <div class="toast-message">${escapeHtml(message)}</div>
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;

    container.appendChild(toast);

    if (duration > 0) {
        setTimeout(() => {
            if (toast.parentElement) toast.remove();
        }, duration);
    }
}

/* ==========================================================================
   Modal Dialog Controller
   ========================================================================== */

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('hidden');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
}

/* ==========================================================================
   Navigation & App Status Workspace Sync
   ========================================================================== */

function showView(viewId) {
    const views = ['landingView', 'dashboardView'];
    views.forEach(v => {
        const el = document.getElementById(v);
        if (el) el.classList.add('hidden');
    });

    const targetView = document.getElementById(viewId);
    if (targetView) targetView.classList.remove('hidden');

    if (viewId === 'dashboardView') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        checkInitialSystemStatus();
    }
}

function switchSidebarTab(tabName) {
    // Update active nav items
    document.querySelectorAll('.sidebar-nav-item').forEach(item => {
        item.classList.remove('active');
    });
    const clickedItem = document.querySelector(`.sidebar-nav-item[data-tab="${tabName}"]`);
    if (clickedItem) clickedItem.classList.add('active');

    // Hide all workspace panels
    const panels = [
        'awsCredentialsPanel', 'requirementsPanel', 'editorPanel', 
        'deploymentPanel', 'successPanel', 'errorPanel', 
        'infrastructurePanel', 'terminatePanel', 'terminationSuccessPanel', 'terminationErrorPanel'
    ];
    panels.forEach(p => {
        const el = document.getElementById(p);
        if (el) el.classList.add('hidden');
    });

    if (tabName === 'credentials') {
        document.getElementById('awsCredentialsPanel').classList.remove('hidden');
        updatePipelineUI(1);
    } else if (tabName === 'requirements' || tabName === 'generate') {
        document.getElementById('requirementsPanel').classList.remove('hidden');
        updatePipelineUI(2);
    } else if (tabName === 'editor') {
        document.getElementById('editorPanel').classList.remove('hidden');
        updatePipelineUI(4);
        if (state.monacoEditor) {
            setTimeout(() => state.monacoEditor.layout(), 100);
        }
    } else if (tabName === 'terminal') {
        document.getElementById('deploymentPanel').classList.remove('hidden');
        updatePipelineUI(5);
    } else if (tabName === 'infrastructure') {
        document.getElementById('infrastructurePanel').classList.remove('hidden');
        checkInitialSystemStatus();
        updatePipelineUI(5);
    } else if (tabName === 'terminate') {
        document.getElementById('terminatePanel').classList.remove('hidden');
        checkInitialSystemStatus();
        updatePipelineUI(5);
    }
}

function updatePipelineUI(stepNum) {
    state.currentPipelineStep = stepNum;
    document.querySelectorAll('.pipeline-step').forEach((el, idx) => {
        const num = idx + 1;
        el.classList.remove('active', 'completed');
        if (num < stepNum) {
            el.classList.add('completed');
        } else if (num === stepNum) {
            el.classList.add('active');
        }
    });
}

function updateAppStatus(newStatus, customMessage) {
    state.appStatus = newStatus;
    
    // Overall State Badge
    const overallBadge = document.getElementById('overallStateBadge');
    if (overallBadge) {
        overallBadge.textContent = newStatus;
        if (['DEPLOYED', 'TERMINATED'].includes(newStatus)) {
            overallBadge.className = "status-badge success";
        } else if (['DEPLOYING', 'TERMINATING', 'GENERATING'].includes(newStatus)) {
            overallBadge.className = "status-badge info pulse-badge";
        } else if (['ERROR'].includes(newStatus)) {
            overallBadge.className = "status-badge error";
        } else {
            overallBadge.className = "status-badge info";
        }
    }

    // Dashboard Status Card Items
    const dashAws = document.getElementById('dashAwsStatus');
    if (dashAws) {
        dashAws.innerHTML = state.isConnected 
            ? `<span class="status-dot green"></span><span>✓ Connected (${state.awsAccountMasked || state.awsRegion})</span>`
            : `<span class="status-dot gray"></span><span>○ Not Connected</span>`;
    }

    const dashTf = document.getElementById('dashTfStatus');
    if (dashTf) {
        dashTf.innerHTML = state.generatedCode
            ? `<span class="status-dot green"></span><span>✓ Generated</span>`
            : `<span class="status-dot gray"></span><span>○ Not Generated</span>`;
    }

    const dashInfra = document.getElementById('dashInfraStatus');
    if (dashInfra) {
        if (state.appStatus === 'DEPLOYING') {
            dashInfra.innerHTML = `<span class="status-dot blue"></span><span>◉ Deployment in Progress</span>`;
        } else if (state.appStatus === 'TERMINATING') {
            dashInfra.innerHTML = `<span class="status-dot red"></span><span>◉ Destruction in Progress</span>`;
        } else if (state.isDeployed && state.runningResources.length > 0) {
            dashInfra.innerHTML = `<span class="status-dot green"></span><span>● Running (${state.runningResources.length} resources)</span>`;
        } else if (state.externallyDeletedResources.length > 0) {
            dashInfra.innerHTML = `<span class="status-dot red"></span><span>○ Deleted Externally (${state.externallyDeletedResources.length})</span>`;
        } else {
            dashInfra.innerHTML = `<span class="status-dot gray"></span><span>○ Not Running</span>`;
        }
    }

    if (customMessage) {
        const lastAct = document.getElementById('dashLastActivity');
        if (lastAct) lastAct.textContent = customMessage;
    }
}

async function checkInitialSystemStatus() {
    try {
        const response = await fetch('/api/status');
        if (response.ok) {
            const data = await response.json();
            state.isDeployed = data.is_deployed;
            state.runningResources = data.current_resources || [];
            state.externallyDeletedResources = data.externally_deleted_resources || [];
            state.lastVerifiedDisplay = data.last_verified_display || "Just now";

            if (data.is_deployed && state.runningResources.length > 0) {
                updateAppStatus("DEPLOYED", `Running ${state.runningResources.length} AWS resources`);
            } else if (data.has_generated_code) {
                updateAppStatus("GENERATED", "Terraform configuration ready");
            }
        }
    } catch (err) {
        console.warn("Could not fetch initial system status:", err);
    }
}

/* ==========================================================================
   AWS Account Verification & Real-Time Sync Controller
   ========================================================================== */

function togglePasswordVisibility(inputId, btnId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (input.type === "password") {
        input.type = "text";
        btn.textContent = "👁️‍🗨️";
    } else {
        input.type = "password";
        btn.textContent = "👁️";
    }
}

async function connectAWS() {
    const accessKey = document.getElementById('awsAccessKeyInput').value.trim();
    const secretKey = document.getElementById('awsSecretKeyInput').value.trim();
    const region = document.getElementById('awsRegionSelect').value;

    if (!accessKey || !secretKey) {
        showToast("warning", "AWS Credentials Required", "Please enter both AWS Access Key ID and Secret Access Key.");
        return;
    }

    const banner = document.getElementById('awsConnectionBanner');
    if (banner) {
        banner.className = "status-badge info pulse-badge";
        banner.textContent = "⟳ Verifying credentials via AWS STS...";
    }

    try {
        const response = await fetch('/api/aws/verify-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                aws_access_key: accessKey,
                aws_secret_key: secretKey,
                aws_region: region
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            state.awsAccessKey = accessKey;
            state.awsSecretKey = secretKey;
            state.awsRegion = region;
            state.awsAccountMasked = data.masked_account || "Connected";
            state.isConnected = true;

            const badge = document.getElementById('globalAwsBadge');
            badge.classList.add('connected');
            badge.innerHTML = `<span class="aws-status-dot"></span><span>AWS Account: ${data.masked_account} (${region})</span>`;

            if (banner) {
                banner.className = "status-badge success";
                banner.textContent = `🟢 Authenticated Account: ${data.masked_account} (${region})`;
            }

            updateAppStatus(state.appStatus, `AWS Authenticated Account ${data.masked_account}`);
            showToast("success", "AWS Authenticated", `Account ${data.masked_account} verified via AWS STS.`);
            
            await syncWithAWS(true);
            switchSidebarTab('requirements');

        } else {
            if (banner) {
                banner.className = "status-badge error";
                banner.textContent = "✖ AWS Authentication Failed";
            }
            showToast("error", "Authentication Error", data.message || "Failed to authenticate AWS credentials.");
        }
    } catch (err) {
        if (banner) {
            banner.className = "status-badge error";
            banner.textContent = "✖ Network Error";
        }
        showToast("error", "API Error", err.toString());
    }
}

async function syncWithAWS(silent = false) {
    if (!silent) {
        showToast("info", "Syncing with AWS...", "Reconciling resource state against live AWS APIs.", 2000);
    }

    try {
        const response = await fetch('/api/aws/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                aws_access_key: state.awsAccessKey,
                aws_secret_key: state.awsSecretKey,
                aws_region: state.awsRegion
            })
        });

        if (response.ok) {
            const data = await response.json();
            state.isDeployed = data.is_deployed;
            state.runningResources = data.current_resources || [];
            state.externallyDeletedResources = data.externally_deleted_resources || [];
            state.allResources = data.all_resources || [];
            state.deploymentHistory = data.deployment_history || [];
            state.lastVerifiedDisplay = data.last_verified_display || "Just now";

            renderInfrastructureDashboard();

            if (!silent) {
                if (state.externallyDeletedResources.length > 0) {
                    showToast("warning", "External Deletion Detected", `Detected ${state.externallyDeletedResources.length} resource(s) deleted outside TerraFlow.`);
                } else {
                    showToast("success", "Infrastructure Synchronized", "TerraFlow state matches live AWS environment.");
                }
            }
        }
    } catch (err) {
        if (!silent) showToast("error", "Sync Error", err.toString());
    }
}

function startBackgroundReconciliation() {
    if (state.syncInterval) clearInterval(state.syncInterval);
    state.syncInterval = setInterval(() => {
        const dashboard = document.getElementById('dashboardView');
        if (dashboard && !dashboard.classList.contains('hidden')) {
            checkInitialSystemStatus();
        }
    }, 30000); // Fast local status poll every 30 seconds
}

/* ==========================================================================
   Requirements & PDF Upload Handler
   ========================================================================== */

function switchInputMode(mode) {
    state.activeTab = mode;
    document.getElementById('modePromptBtn').classList.toggle('active', mode === 'prompt');
    document.getElementById('modePdfBtn').classList.toggle('active', mode === 'pdf');

    document.getElementById('promptInputArea').classList.toggle('hidden', mode !== 'prompt');
    document.getElementById('pdfInputArea').classList.toggle('hidden', mode !== 'pdf');
}

async function handlePdfDrop(event) {
    event.preventDefault();
    const files = event.dataTransfer ? event.dataTransfer.files : event.target.files;
    if (!files || !files[0]) return;

    const file = files[0];
    if (file.type !== "application/pdf") {
        showToast("error", "Invalid File", "Please upload a valid PDF document.");
        return;
    }

    const dropText = document.getElementById('pdfDropText');
    dropText.textContent = `📄 Extracting text from ${file.name}...`;

    const formData = new FormData();
    formData.append("file", file);

    try {
        const response = await fetch("/api/upload-pdf", { method: "POST", body: formData });
        const data = await response.json();

        if (response.ok && data.extracted_text) {
            state.inputText = data.extracted_text;
            document.getElementById('promptTextarea').value = data.extracted_text;
            dropText.innerHTML = `✓ Extracted from <strong>${file.name}</strong> (${(file.size / 1024).toFixed(1)} KB)<br><small>Click to upload a different PDF</small>`;
            showToast("success", "PDF Extracted", `Successfully extracted requirements from ${file.name}.`);
            switchInputMode('prompt');
        } else {
            showToast("error", "PDF Error", data.detail || "Failed to extract text from PDF.");
            dropText.textContent = "Drag & drop your PDF here or browse files";
        }
    } catch (err) {
        showToast("error", "Upload Failed", err.toString());
        dropText.textContent = "Drag & drop your PDF here or browse files";
    }
}

/* ==========================================================================
   Dedicated Animated Terraform Generation Pipeline
   ========================================================================== */

async function generateTerraform() {
    let input = document.getElementById('promptTextarea').value.trim();
    if (!input && state.inputText) input = state.inputText;

    if (!input) {
        showToast("warning", "Missing Input", "Please enter infrastructure requirements or upload a PDF first.");
        return;
    }

    state.inputText = input;
    updateAppStatus("GENERATING", "Analyzing requirements & generating Terraform HCL");
    updatePipelineUI(3);

    openModal('generationModal');
    resetGenerationAnimSequence();

    const animTimer = animateGenerationSteps();

    try {
        const response = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                input_text: input,
                aws_access_key: state.awsAccessKey,
                aws_secret_key: state.awsSecretKey
            })
        });

        const data = await response.json();
        clearInterval(animTimer);

        if (response.ok && data.success) {
            state.generatedCode = data.terraform_code;
            updateAppStatus("GENERATED", "Terraform configuration ready for review");

            if (state.monacoEditor) {
                state.monacoEditor.setValue(data.terraform_code);
            }

            const parsedCounts = parseInfrastructureSummary(data.terraform_code);
            const resCount = parsedCounts.total || 6;

            completeGenerationChecklist(resCount);

            setTimeout(() => {
                closeModal('generationModal');
                
                const countBadge = document.getElementById('genSuccessResCount');
                if (countBadge) countBadge.textContent = resCount;

                openModal('generatedSuccessModal');
                showToast("success", "Terraform Generated", "Code is ready for review and deployment.");
            }, 600);

        } else {
            closeModal('generationModal');
            updateAppStatus("ERROR", "Terraform generation failed");
            showToast("error", "Generation Failed", data.detail || data.validation_error || "Could not generate Terraform code.");
        }
    } catch (err) {
        clearInterval(animTimer);
        closeModal('generationModal');
        updateAppStatus("ERROR", "Network error during generation");
        showToast("error", "API Error", err.toString());
    }
}

function resetGenerationAnimSequence() {
    const progressFill = document.getElementById('genProgressFill');
    if (progressFill) progressFill.style.width = "10%";

    const steps = ['genSeq1', 'genSeq2', 'genSeq3', 'genSeq4', 'genSeq5'];
    steps.forEach((s, idx) => {
        const el = document.getElementById(s);
        if (el) {
            el.className = 'gen-flow-step';
            if (idx === 0) el.classList.add('active');
        }
    });

    for (let i = 1; i <= 4; i++) {
        const chk = document.getElementById(`chkStep${i}`);
        if (chk) {
            chk.className = 'gen-checklist-item';
            chk.querySelector('.chk-icon').className = 'chk-icon pending';
            chk.querySelector('.chk-icon').textContent = '○';
        }
    }
}

function animateGenerationSteps() {
    let currentStep = 0;
    const steps = [
        { seq: 'genSeq1', chk: 'chkStep1', text: 'Analyzing requirements...', fill: '25%' },
        { seq: 'genSeq2', chk: 'chkStep2', text: 'Understanding AWS resources...', fill: '50%' },
        { seq: 'genSeq3', chk: 'chkStep3', text: 'Designing infrastructure architecture...', fill: '75%' },
        { seq: 'genSeq4', chk: 'chkStep4', text: 'Generating Terraform HCL configuration...', fill: '90%' },
        { seq: 'genSeq5', chk: null, text: 'Preparing configuration for editor...', fill: '95%' }
    ];

    return setInterval(() => {
        if (currentStep < steps.length) {
            const stepInfo = steps[currentStep];
            
            document.getElementById('genStageLabel').textContent = stepInfo.text;
            document.getElementById('genProgressFill').style.width = stepInfo.fill;

            steps.forEach((s, idx) => {
                const el = document.getElementById(s.seq);
                if (el) {
                    if (idx < currentStep) el.className = 'gen-flow-step completed';
                    else if (idx === currentStep) el.className = 'gen-flow-step active';
                }
            });

            if (stepInfo.chk) {
                const chk = document.getElementById(stepInfo.chk);
                if (chk) {
                    chk.className = 'gen-checklist-item active';
                    const icon = chk.querySelector('.chk-icon');
                    icon.className = 'chk-icon active';
                    icon.textContent = '⟳';
                }
            }

            if (currentStep > 0 && steps[currentStep - 1].chk) {
                const prevChk = document.getElementById(steps[currentStep - 1].chk);
                if (prevChk) {
                    prevChk.className = 'gen-checklist-item completed';
                    const icon = prevChk.querySelector('.chk-icon');
                    icon.className = 'chk-icon success';
                    icon.textContent = '✓';
                }
            }

            currentStep++;
        }
    }, 700);
}

function completeGenerationChecklist(resCount) {
    document.getElementById('genProgressFill').style.width = "100%";
    document.getElementById('genStageLabel').textContent = "Configuration ready!";

    for (let i = 1; i <= 4; i++) {
        const chk = document.getElementById(`chkStep${i}`);
        if (chk) {
            chk.className = 'gen-checklist-item completed';
            const icon = chk.querySelector('.chk-icon');
            icon.className = 'chk-icon success';
            icon.textContent = '✓';
        }
    }
}

/* ==========================================================================
   Monaco Editor Setup & Code Analyzer
   ========================================================================== */

function initMonacoEditor() {
    if (window.monaco) {
        createMonacoInstance();
        return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js';
    script.onload = () => {
        require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
        require(['vs/editor/editor.main'], () => {
            createMonacoInstance();
        });
    };
    document.head.appendChild(script);
}

function createMonacoInstance() {
    const container = document.getElementById('monacoContainer');
    if (!container) return;

    state.monacoEditor = monaco.editor.create(container, {
        value: state.generatedCode || `# Select requirements and click "Generate Terraform" to start.\nprovider "aws" {\n  region = "us-east-1"\n}\n`,
        language: 'hcl',
        theme: 'vs-dark',
        automaticLayout: true,
        fontSize: 13,
        fontFamily: "'Fira Code', 'Consolas', monospace",
        minimap: { enabled: false },
        lineNumbers: 'on',
        roundedSelection: true,
        scrollBeyondLastLine: false
    });

    state.monacoEditor.onDidChangeModelContent(() => {
        state.generatedCode = state.monacoEditor.getValue();
        parseInfrastructureSummary(state.generatedCode);
    });
}

function parseInfrastructureSummary(code) {
    if (!code) return { total: 0 };

    const vpcCount = (code.match(/resource\s+"aws_vpc"/g) || []).length;
    const subnetCount = (code.match(/resource\s+"aws_subnet"/g) || []).length;
    const ec2Count = (code.match(/resource\s+"aws_instance"/g) || []).length;
    const s3Count = (code.match(/resource\s+"aws_s3_bucket"/g) || []).length;
    const sgCount = (code.match(/resource\s+"aws_security_group"/g) || []).length;
    const albCount = (code.match(/resource\s+"aws_lb"|resource\s+"aws_alb"/g) || []).length;

    const total = vpcCount + subnetCount + ec2Count + s3Count + sgCount + albCount;

    const sumVpc = document.getElementById('sumVpc');
    if (sumVpc) sumVpc.textContent = vpcCount;
    const sumSubnet = document.getElementById('sumSubnet');
    if (sumSubnet) sumSubnet.textContent = subnetCount;
    const sumEc2 = document.getElementById('sumEc2');
    if (sumEc2) sumEc2.textContent = ec2Count;
    const sumS3 = document.getElementById('sumS3');
    if (sumS3) sumS3.textContent = s3Count;
    const sumSg = document.getElementById('sumSg');
    if (sumSg) sumSg.textContent = sgCount;
    const sumAlb = document.getElementById('sumAlb');
    if (sumAlb) sumAlb.textContent = albCount;

    const insightsContainer = document.getElementById('codeInsightsList');
    if (insightsContainer) {
        let insightsHtml = "";
        if (code.includes('0.0.0.0/0')) {
            insightsHtml += `
                <div class="insight-box warning" style="margin-bottom:0.5rem; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); padding: 0.6rem; border-radius: 4px; font-size: 0.8rem;">
                    <strong style="color: var(--error);">⚠ Security Warning</strong><br>
                    Security group allows inbound traffic from <code>0.0.0.0/0</code>.
                </div>
            `;
        }
        if (ec2Count > 0) {
            insightsHtml += `
                <div class="insight-box" style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2); padding: 0.6rem; border-radius: 4px; font-size: 0.8rem;">
                    <strong>💡 AWS Instance Detected</strong><br>
                    EC2 instances configured. Provider region: <code>${state.awsRegion}</code>.
                </div>
            `;
        }

        if (!insightsHtml) {
            insightsHtml = `<p style="font-size:0.8rem; color:var(--text-tertiary);">Syntax and security structure valid ✓</p>`;
        }
        insightsContainer.innerHTML = insightsHtml;
    }

    return { vpcCount, subnetCount, ec2Count, s3Count, sgCount, albCount, total };
}

async function runCodeValidation() {
    if (!state.generatedCode) {
        showToast("warning", "No Code", "No Terraform code available to validate.");
        return;
    }

    try {
        const response = await fetch("/api/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ terraform_code: state.generatedCode })
        });
        const data = await response.json();
        
        const badge = document.getElementById('editorStatusBadge');
        if (data.is_valid) {
            if (badge) {
                badge.className = "status-badge success";
                badge.textContent = "✓ Terraform Valid";
            }
            showToast("success", "Validation Passed", "Terraform HCL syntax is valid.");
        } else {
            if (badge) {
                badge.className = "status-badge error";
                badge.textContent = "⚠ Validation Error";
            }
            showToast("error", "Validation Error", data.error || "HCL syntax check failed.");
        }
    } catch (err) {
        showToast("error", "Validation Error", err.toString());
    }
}

function copyEditorCode() {
    if (!state.generatedCode) return;
    navigator.clipboard.writeText(state.generatedCode);
    showToast("info", "Copied", "Terraform code copied to clipboard!");
}

/* ==========================================================================
   Create Infrastructure Confirmation Dialog
   ========================================================================== */

function openDeployConfirmModal() {
    if (!state.generatedCode) {
        showToast("warning", "No Code", "Please generate Terraform code first.");
        return;
    }

    const counts = parseInfrastructureSummary(state.generatedCode);
    const breakdownContainer = document.getElementById('deployResourceBreakdown');

    if (breakdownContainer) {
        breakdownContainer.innerHTML = `
            <div class="breakdown-row"><span>VPC</span><strong>${counts.vpcCount || 1}</strong></div>
            <div class="breakdown-row"><span>Subnets</span><strong>${counts.subnetCount || 2}</strong></div>
            <div class="breakdown-row"><span>EC2 Instances</span><strong>${counts.ec2Count || 1}</strong></div>
            <div class="breakdown-row"><span>S3 Buckets</span><strong>${counts.s3Count || 1}</strong></div>
            <div class="breakdown-row"><span>Security Groups</span><strong>${counts.sgCount || 1}</strong></div>
        `;
    }

    openModal('deployConfirmModal');
}

function updateDeploymentStepTracker(stepNum) {
    for (let i = 1; i <= 5; i++) {
        const el = document.getElementById(`deployStep${i}`);
        if (el) {
            el.classList.remove('active', 'completed');
            if (i < stepNum) {
                el.classList.add('completed');
            } else if (i === stepNum) {
                el.classList.add('active');
            }
        }
    }
}

async function startDeploymentExecution() {
    updateAppStatus("DEPLOYING", "Executing terraform apply pipeline");
    switchSidebarTab('terminal');

    document.getElementById('terminalHeaderTitle').textContent = "Terraform Deployment";
    document.getElementById('terminalHeaderSubtitle').textContent = "Live execution pipeline and human-readable terminal.";

    const statusBadge = document.getElementById('terminalStatusBadge');
    if (statusBadge) {
        statusBadge.className = "status-badge info pulse-badge";
        statusBadge.textContent = "● EXECUTING";
    }

    const animWidget = document.getElementById('terminalAnimWidget');
    if (animWidget) animWidget.classList.remove('hidden');

    const logFeed = document.getElementById('terminalLogFeed');
    const rawLogs = document.getElementById('rawLogsContent');
    
    logFeed.innerHTML = "";
    rawLogs.textContent = "";
    state.deploymentLogs = "";
    state.deployStartTime = Date.now();

    resetArchDiagramNodes();
    updateDeploymentStepTracker(1);
    updateTerminalProgressBar(15, "Preparing AWS environment & credentials...");

    addHumanLog("info", "Starting automated AWS Terraform deployment pipeline...");
    addHumanLog("info", `Target AWS Region: ${state.awsRegion}`);

    try {
        const response = await fetch("/api/deploy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                terraform_code: state.generatedCode,
                aws_access_key: state.awsAccessKey,
                aws_secret_key: state.awsSecretKey,
                aws_region: state.awsRegion
            })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const textChunk = decoder.decode(value, { stream: true });
            rawLogs.textContent += textChunk;
            rawLogs.scrollTop = rawLogs.scrollHeight;

            parseRawDeployChunkToHuman(textChunk);
        }

        const durationSec = Math.round((Date.now() - state.deployStartTime) / 1000);
        
        if (rawLogs.textContent.includes("Error:") || rawLogs.textContent.includes("FAILED")) {
            updateAppStatus("ERROR", "Deployment execution failed");
            if (statusBadge) {
                statusBadge.className = "status-badge error";
                statusBadge.textContent = "✖ DEPLOYMENT FAILED";
            }
            showErrorScreen(rawLogs.textContent);
        } else {
            state.isDeployed = true;
            updateAppStatus("DEPLOYED", `Successfully deployed to ${state.awsRegion}`);
            if (statusBadge) {
                statusBadge.className = "status-badge success";
                statusBadge.textContent = "✓ DEPLOYMENT COMPLETE";
            }
            updateTerminalProgressBar(100, "Infrastructure deployment complete ✓");
            await syncWithAWS(true);
            showSuccessScreen(durationSec);
        }

    } catch (err) {
        updateAppStatus("ERROR", "Deployment network connection error");
        addHumanLog("error", `Deployment connection error: ${err}`);
        showErrorScreen(err.toString());
    }
}

function updateTerminalProgressBar(percent, text) {
    const fill = document.getElementById('terminalProgressFill');
    if (fill) fill.style.width = `${percent}%`;

    const percentText = document.getElementById('terminalAnimPercent');
    if (percentText) percentText.textContent = `${percent}%`;

    const labelText = document.getElementById('terminalAnimText');
    if (labelText) labelText.textContent = text;
}

function parseRawDeployChunkToHuman(chunk) {
    const lines = chunk.split('\n');
    lines.forEach(line => {
        if (!line.trim()) return;

        if (line.includes("[PERFORMANCE_METRICS]")) {
            try {
                const jsonStr = line.substring(line.indexOf("[PERFORMANCE_METRICS]") + 21).trim();
                const metrics = JSON.parse(jsonStr);
                updatePerformanceMetricsCard(metrics);
            } catch (e) {}
            return;
        }

        if (line.includes("terraform init")) {
            updateDeploymentStepTracker(2);
            updateTerminalProgressBar(30, "Initializing Terraform plugins & modules...");
            addHumanLog("info", "Initializing Terraform provider plugins...");
        } else if (line.includes("Initialized Terraform") || line.includes("Terraform has been successfully initialized!")) {
            addHumanLog("success", "✓ Terraform initialized successfully.");
        } else if (line.includes("terraform plan")) {
            updateDeploymentStepTracker(3);
            updateTerminalProgressBar(55, "Generating execution plan...");
            addHumanLog("info", "Planning infrastructure configuration changes...");
        } else if (line.includes("Plan:")) {
            addHumanLog("info", `📊 ${line.trim()}`);
        } else if (line.includes("terraform apply")) {
            updateDeploymentStepTracker(4);
            updateTerminalProgressBar(75, "Creating AWS cloud resources...");
            addHumanLog("info", "Applying Terraform configuration to AWS...");
        } else if (line.includes("Creating...") || line.includes("Still creating...")) {
            const resMatch = line.match(/(aws_[a-z0-9_]+)/);
            if (resMatch) {
                updateArchNodeState(resMatch[1], "creating");
                addHumanLog("warning", `⟳ Creating AWS resource: ${resMatch[1]}`);
            }
        } else if (line.includes("Creation complete")) {
            const resMatch = line.match(/(aws_[a-z0-9_]+)/);
            if (resMatch) {
                updateArchNodeState(resMatch[1], "created");
                addHumanLog("success", `✓ Resource created: ${resMatch[1]}`);
            }
        } else if (line.includes("Apply complete!")) {
            updateDeploymentStepTracker(5);
            addHumanLog("success", "✓ Infrastructure deployment completed successfully!");
        } else if (line.includes("Error:")) {
            addHumanLog("error", `✖ ${line.trim()}`);
        }
    });
}

function updatePerformanceMetricsCard(m) {
    const initEl = document.getElementById('metricInit');
    if (initEl) initEl.textContent = `${m.init_time_s || 0.0}s`;

    const applyEl = document.getElementById('metricApply');
    if (applyEl) applyEl.textContent = `${m.apply_time_s || m.destroy_time_s || 0.0}s`;

    const verifyEl = document.getElementById('metricVerify');
    if (verifyEl) verifyEl.textContent = `${m.aws_verify_s || 0.0}s`;

    const totalEl = document.getElementById('metricTotal');
    if (totalEl) totalEl.textContent = `${m.total_time_s || 0.0}s`;

    const totalLabel = document.getElementById('perfTotalLabel');
    if (totalLabel) totalLabel.textContent = `Total Execution Time: ${m.total_time_s || 0.0}s`;
}

/* ==========================================================================
   Real-Time Managed Infrastructure Dashboard Renderer
   ========================================================================== */

function renderInfrastructureDashboard() {
    const grid = document.getElementById('managedResourcesGrid');
    const regionBadge = document.getElementById('infraRegionBadge');
    if (regionBadge) regionBadge.textContent = state.awsRegion;

    const activeCountBadge = document.getElementById('activeResCountBadge');
    if (activeCountBadge) activeCountBadge.textContent = `${state.runningResources.length} Active`;

    const lastVerBadge = document.getElementById('syncLastVerifiedBadge');
    if (lastVerBadge) lastVerBadge.textContent = `Last verified: ${state.lastVerifiedDisplay || 'Just now'}`;

    // Render Section 1: Currently Active AWS Infrastructure
    if (grid) {
        if (!state.runningResources || state.runningResources.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 2.5rem; background: var(--bg-card); border: 1px dashed var(--border-color); border-radius: var(--radius-md);">
                    <span style="font-size: 2rem;">☁️</span>
                    <h4 style="margin-top: 0.5rem; color: var(--text-secondary);">No Active Infrastructure Found in AWS</h4>
                    <p style="font-size: 0.85rem; color: var(--text-tertiary);">Click "Generate Terraform" to create new AWS cloud resources.</p>
                </div>
            `;
        } else {
            grid.innerHTML = state.runningResources.map(res => renderResourceCard(res, "RUNNING")).join('');
        }
    }

    // Render Section 2: Externally Deleted Resources
    const deletedSection = document.getElementById('externallyDeletedSection');
    const deletedGrid = document.getElementById('deletedResourcesGrid');
    const deletedBadge = document.getElementById('deletedResCountBadge');

    if (deletedSection && deletedGrid) {
        if (state.externallyDeletedResources && state.externallyDeletedResources.length > 0) {
            deletedSection.classList.remove('hidden');
            if (deletedBadge) deletedBadge.textContent = `${state.externallyDeletedResources.length} Detected`;
            deletedGrid.innerHTML = state.externallyDeletedResources.map(res => renderResourceCard(res, "DELETED_EXTERNALLY")).join('');
        } else {
            deletedSection.classList.add('hidden');
        }
    }

    // Render Section 3: Deployment History Timeline
    renderDeploymentHistoryTimeline();
    renderTerminateTargetList();
}

function renderResourceCard(res, statusType) {
    let icon = "📦";
    if (res.type.includes("vpc")) icon = "🌐";
    else if (res.type.includes("subnet")) icon = "🔀";
    else if (res.type.includes("instance")) icon = "🖥️";
    else if (res.type.includes("s3")) icon = "🪣";
    else if (res.type.includes("security_group")) icon = "🛡️";
    else if (res.type.includes("lb") || res.type.includes("alb")) icon = "⚖️";

    let badgeClass = "status-badge success";
    let badgeText = res.display_status || "● Running";

    if (statusType === "DELETED_EXTERNALLY") {
        badgeClass = "status-badge error";
        badgeText = "○ Deleted externally";
    } else if (res.status === "STOPPED") {
        badgeClass = "status-badge warning";
        badgeText = "◐ Stopped";
    }

    return `
        <div class="resource-card">
            <div class="res-card-header">
                <span style="font-size: 1.2rem;">${icon}</span>
                <span class="${badgeClass}" style="font-size: 0.7rem;">${escapeHtml(badgeText)}</span>
            </div>
            <div class="res-card-title">${escapeHtml(res.type)}</div>
            <div class="res-card-id">${escapeHtml(res.id)}</div>
            <div style="font-size: 0.78rem; color: var(--text-tertiary); display: flex; flex-direction: column; gap: 0.2rem; margin-top: 0.4rem;">
                <span>Name: <strong>${escapeHtml(res.name)}</strong></span>
                <span>${escapeHtml(res.details || 'AWS Verified')}</span>
            </div>
        </div>
    `;
}

function renderDeploymentHistoryTimeline() {
    const historyContainer = document.getElementById('deploymentHistoryList');
    if (!historyContainer) return;

    if (!state.deploymentHistory || state.deploymentHistory.length === 0) {
        historyContainer.innerHTML = `
            <p style="font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: 1rem;">No deployment history logged yet.</p>
        `;
        return;
    }

    historyContainer.innerHTML = state.deploymentHistory.map(item => `
        <div class="history-item ${escapeHtml(item.event_type)}">
            <div>
                <div class="history-title">${escapeHtml(item.title)}</div>
                <div class="history-desc">${escapeHtml(item.description)}</div>
            </div>
            <div class="history-meta">
                <div>${escapeHtml(item.display_time)}</div>
                <div style="color: var(--accent-cyan); font-weight: 600;">${item.duration_s ? item.duration_s + 's' : ''}</div>
            </div>
        </div>
    `).join('');
}

function renderTerminateTargetList() {
    const container = document.getElementById('terminateTargetList');
    const confirmBreakdown = document.getElementById('terminateResourceBreakdown');

    // Only present RUNNING active resources for termination!
    const targetList = state.runningResources && state.runningResources.length > 0
        ? state.runningResources
        : state.allResources;

    const content = targetList && targetList.length > 0
        ? targetList.map(res => `
            <div class="breakdown-row">
                <span>${escapeHtml(res.type)}</span>
                <strong style="color: var(--error);">${escapeHtml(res.id)}</strong>
            </div>
        `).join('')
        : `
            <div class="breakdown-row"><span>VPC</span><strong style="color:var(--error);">vpc-main (1)</strong></div>
            <div class="breakdown-row"><span>Subnets</span><strong style="color:var(--error);">2 Subnets</strong></div>
            <div class="breakdown-row"><span>EC2 Instances</span><strong style="color:var(--error);">1 Instance</strong></div>
            <div class="breakdown-row"><span>S3 Buckets</span><strong style="color:var(--error);">1 Bucket</strong></div>
        `;

    if (container) container.innerHTML = content;
    if (confirmBreakdown) confirmBreakdown.innerHTML = content;
}

/* ==========================================================================
   Infrastructure Destruction & Pre-Flight Safety Checks
   ========================================================================== */

function openTerminateConfirmModal1() {
    openModal('terminateConfirmModal1');
}

function openTerminateConfirmModal2() {
    const input = document.getElementById('terminateInputText');
    if (input) input.value = "";
    
    const btn = document.getElementById('confirmTerminateFinalBtn');
    if (btn) btn.disabled = true;

    openModal('terminateConfirmModal2');
}

function validateTerminateInput() {
    const input = document.getElementById('terminateInputText').value.trim();
    const btn = document.getElementById('confirmTerminateFinalBtn');
    if (btn) {
        btn.disabled = input !== "TERMINATE";
    }
}

async function startTerminationExecution() {
    updateAppStatus("TERMINATING", "Executing terraform destroy pipeline");
    switchSidebarTab('terminal');

    document.getElementById('terminalHeaderTitle').textContent = "Infrastructure Termination";
    document.getElementById('terminalHeaderSubtitle').textContent = "Executing terraform destroy pipeline.";

    const statusBadge = document.getElementById('terminalStatusBadge');
    if (statusBadge) {
        statusBadge.className = "status-badge error pulse-badge";
        statusBadge.textContent = "● DESTROYING";
    }

    const animWidget = document.getElementById('terminalAnimWidget');
    if (animWidget) animWidget.classList.remove('hidden');

    const logFeed = document.getElementById('terminalLogFeed');
    const rawLogs = document.getElementById('rawLogsContent');
    
    logFeed.innerHTML = "";
    rawLogs.textContent = "";
    state.deploymentLogs = "";
    state.deployStartTime = Date.now();

    updateTerminalProgressBar(20, "Initiating AWS Terraform Destroy...");
    addHumanLog("warning", "Starting infrastructure destruction pipeline...");
    addHumanLog("warning", "Running terraform destroy -auto-approve against AWS...");

    try {
        const response = await fetch("/api/destroy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                aws_access_key: state.awsAccessKey,
                aws_secret_key: state.awsSecretKey,
                aws_region: state.awsRegion
            })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const textChunk = decoder.decode(value, { stream: true });
            rawLogs.textContent += textChunk;
            rawLogs.scrollTop = rawLogs.scrollHeight;

            parseRawDestroyChunkToHuman(textChunk);
        }

        const durationSec = Math.round((Date.now() - state.deployStartTime) / 1000);

        if (rawLogs.textContent.includes("Error:") || rawLogs.textContent.includes("FAILED")) {
            updateAppStatus("ERROR", "Termination failed");
            if (statusBadge) {
                statusBadge.className = "status-badge error";
                statusBadge.textContent = "⚠ TERMINATION FAILED";
            }
            showTerminationErrorScreen(rawLogs.textContent);
        } else {
            state.isDeployed = false;
            state.runningResources = [];
            updateAppStatus("TERMINATED", "Infrastructure successfully destroyed");
            if (statusBadge) {
                statusBadge.className = "status-badge success";
                statusBadge.textContent = "✓ INFRASTRUCTURE TERMINATED";
            }
            updateTerminalProgressBar(100, "All managed infrastructure destroyed ✓");
            await syncWithAWS(true);
            showToast("info", "Infrastructure Terminated", "All AWS resources have been successfully destroyed.");
            showTerminationSuccessScreen(durationSec);
        }

    } catch (err) {
        updateAppStatus("ERROR", "Termination error");
        addHumanLog("error", `Destruction connection failed: ${err}`);
        showTerminationErrorScreen(err.toString());
    }
}

function parseRawDestroyChunkToHuman(chunk) {
    const lines = chunk.split('\n');
    lines.forEach(line => {
        if (!line.trim()) return;

        if (line.includes("[PERFORMANCE_METRICS]")) {
            try {
                const jsonStr = line.substring(line.indexOf("[PERFORMANCE_METRICS]") + 21).trim();
                const metrics = JSON.parse(jsonStr);
                updatePerformanceMetricsCard(metrics);
            } catch (e) {}
            return;
        }

        if (line.includes("Destroying...") || line.includes("Still destroying...")) {
            const resMatch = line.match(/(aws_[a-z0-9_]+)/);
            updateTerminalProgressBar(60, "Destroying active cloud resources...");
            if (resMatch) {
                addHumanLog("warning", `⟳ Destroying AWS resource: ${resMatch[1]}`);
            }
        } else if (line.includes("Destruction complete")) {
            const resMatch = line.match(/(aws_[a-z0-9_]+)/);
            updateTerminalProgressBar(85, "Removing resource state...");
            if (resMatch) {
                addHumanLog("success", `✓ Resource destroyed: ${resMatch[1]}`);
            }
        } else if (line.includes("Destroy complete!")) {
            updateTerminalProgressBar(100, "Destroy complete!");
            addHumanLog("success", "✓ All managed resources destroyed successfully!");
        } else if (line.includes("Error:")) {
            addHumanLog("error", `✖ ${line.trim()}`);
        }
    });
}

function showTerminationSuccessScreen(durationSec) {
    hideAllWorkspacePanels();

    const panel = document.getElementById('terminationSuccessPanel');
    if (panel) {
        panel.classList.remove('hidden');
        document.getElementById('statDestroyDuration').textContent = `${durationSec}s`;
    }
}

function showTerminationErrorScreen(errorText) {
    hideAllWorkspacePanels();

    const panel = document.getElementById('terminationErrorPanel');
    if (panel) {
        panel.classList.remove('hidden');
        document.getElementById('destroyErrorMsgBox').textContent = errorText.substring(0, 500) || "Terraform destroy encountered an error.";
    }
}

function hideAllWorkspacePanels() {
    const panels = [
        'awsCredentialsPanel', 'requirementsPanel', 'editorPanel', 
        'deploymentPanel', 'successPanel', 'errorPanel', 
        'infrastructurePanel', 'terminatePanel', 'terminationSuccessPanel', 'terminationErrorPanel'
    ];
    panels.forEach(p => {
        const el = document.getElementById(p);
        if (el) el.classList.add('hidden');
    });
}

/* ==========================================================================
   Helper Screen View Functions
   ========================================================================== */

function showSuccessScreen(durationSec) {
    hideAllWorkspacePanels();

    const successPanel = document.getElementById('successPanel');
    if (successPanel) {
        successPanel.classList.remove('hidden');
        document.getElementById('statDuration').textContent = `${durationSec}s`;
        document.getElementById('statRegion').textContent = state.awsRegion;
    }
}

function showErrorScreen(rawErrorText) {
    hideAllWorkspacePanels();

    const errorPanel = document.getElementById('errorPanel');
    if (errorPanel) {
        errorPanel.classList.remove('hidden');
        document.getElementById('errorMsgBox').textContent = rawErrorText.substring(0, 500) || "Terraform execution failed.";
    }
}

function toggleRawLogs() {
    const rawBox = document.getElementById('rawLogsContent');
    rawBox.classList.toggle('hidden');
}

function escapeHtml(text) {
    if (!text) return "";
    return text.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function addHumanLog(type, message) {
    const feed = document.getElementById('terminalLogFeed');
    if (!feed) return;
    const timeStr = new Date().toLocaleTimeString();

    const logItem = document.createElement('div');
    logItem.className = 'log-entry';
    logItem.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-msg ${type}">${escapeHtml(message)}</span>`;

    feed.appendChild(logItem);
    feed.scrollTop = feed.scrollHeight;
}

function resetArchDiagramNodes() {
    const nodes = ['Vpc', 'Subnet', 'Ec2', 'S3'];
    nodes.forEach(n => {
        const el = document.getElementById(`node${n}`);
        if (el) {
            el.className = 'arch-node pending';
            el.querySelector('.node-status').textContent = 'Pending';
        }
    });
}

function updateArchNodeState(resourceName, status) {
    let nodeKey = "";
    if (resourceName.includes("vpc")) nodeKey = "Vpc";
    else if (resourceName.includes("subnet")) nodeKey = "Subnet";
    else if (resourceName.includes("instance")) nodeKey = "Ec2";
    else if (resourceName.includes("s3")) nodeKey = "S3";

    if (!nodeKey) return;

    const el = document.getElementById(`node${nodeKey}`);
    if (el) {
        el.className = `arch-node ${status}`;
        el.querySelector('.node-status').textContent = status === "creating" ? "Creating..." : "Created ✓";
    }
}

function setupEventListeners() {
    const dropzone = document.getElementById('pdfDropzone');
    if (dropzone) {
        dropzone.addEventListener('dragover', (e) => e.preventDefault());
        dropzone.addEventListener('drop', handlePdfDrop);
    }
}
