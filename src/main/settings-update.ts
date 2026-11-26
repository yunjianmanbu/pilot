import type { SettingsUpdate } from '../shared/types'
import type { PersistedSettings } from './store-schema'
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  SETTING_CONTEXT_MAX,
  SETTING_CONTEXT_MIN,
  SETTING_OUTPUT_MAX,
  SETTING_OUTPUT_MIN,
} from '../shared/modelLimits'
import { isLocaleSetting } from '../shared/i18n'
import { normalizeCheckpointIgnore, normalizeCheckpointScope } from '../shared/checkpoint-ignore'
import { normalizeRelayUrl } from '../shared/relay'
import { normalizeServerPort } from '../shared/server-mode'
import { normalizeConfiguredSteps } from '../shared/step-budget'
import { normalizeQualityPublishTarget } from '../shared/quality'
import { normalizeSelfSourceSettings } from './self-source-git'
import {
  clampReflectionInterval,
  normalizeReflectionScheduleMode,
  normalizeReflectionTime,
  normalizeReflectionTopics,
  normalizeReflectionTriggers,
} from '../shared/reflect'
import { clampSmtpPort, normalizeSmtpSecurity } from './reflect/mail'
import {
  normalizeNotifyEmailEvents,
  withNotifyEvent,
} from '../shared/notify-events'
import {
  clampNumber,
  normalizeOptionalText,
  normalizeTestTargets,
  normalizeText,
  sanitizeCommandList,
  sanitizePermissionRules,
  validApprovalMode,
  validFontSize,
  validShellInterpreter,
  validTheme,
} from './store-schema'

/**
 * Settings the store cannot normalise on its own: the API key and the test
 * captcha live in safeStorage, so the caller supplies the writers. They are
 * invoked at the same position in the field sequence as before the split, so a
 * later validation error cannot change what has already been written.
 */
export interface SettingsSecretHooks {
  setTestCaptcha(value: string | null): void
  setApiKey(value: string | null): void
  /** 反思邮件用的 SMTP 密码，同样只以密文入盘。 */
  setSmtpPassword(value: string | null): void
}

/**
 * Every "input field → persisted field" rule for updateSettings in one place.
 * Adding a setting means one line here instead of another branch inside a
 * 200-line method. Callers must have validated resources and reviewers first.
 */
export function applySettingsUpdate(
  settings: PersistedSettings,
  input: SettingsUpdate,
  hooks: SettingsSecretHooks,
): void {
    if (input.maxSteps !== undefined) {
      // 0 = 不限；上限与循环里的硬天花板同源。UI 已拦非法值，这里只是防止旧
      // 客户端或手改 settings.json 写进一个循环无法兑现的数字（也防止负数被
      // 夹成 0 后默默变成「不限」）。
      settings.maxSteps = normalizeConfiguredSteps(input.maxSteps, settings.maxSteps)
    }
    if (input.maxTokens !== undefined) {
      // 0 keeps the budget off; anything else is rounded so the UI cannot send
      // a fractional cap.
      settings.maxTokens = Math.round(clampNumber(input.maxTokens, 0, 0, 20_000_000))
    }
    if (input.maxContextTokens !== undefined) {
      settings.maxContextTokens = clampNumber(
        input.maxContextTokens,
        DEFAULT_CONTEXT_TOKENS,
        SETTING_CONTEXT_MIN,
        SETTING_CONTEXT_MAX,
      )
    }
    if (input.maxOutputTokens !== undefined) {
      settings.maxOutputTokens = clampNumber(
        input.maxOutputTokens,
        DEFAULT_OUTPUT_TOKENS,
        SETTING_OUTPUT_MIN,
        SETTING_OUTPUT_MAX,
      )
    }
    if (input.temperature !== undefined) {
      settings.temperature = clampNumber(input.temperature, 0.2, 0, 1)
    }
    if (input.autoReflect !== undefined) settings.autoReflect = input.autoReflect
    if (input.autoEvolve !== undefined) settings.autoEvolve = input.autoEvolve
    if (input.autoContinue !== undefined) settings.autoContinue = input.autoContinue
    if (input.autoContinueLimit !== undefined) {
      settings.autoContinueLimit = Math.round(
        clampNumber(input.autoContinueLimit, settings.autoContinueLimit, 1, 10),
      )
    }
    if (input.screenshotFeedback !== undefined) {
      settings.screenshotFeedback = input.screenshotFeedback === true
    }
    if (input.reflectEnabled !== undefined) settings.reflectEnabled = input.reflectEnabled === true
    if (input.reflectModelId !== undefined) {
      settings.reflectModelId = normalizeOptionalText(input.reflectModelId, 120)
    }
    if (input.reflectTriggers !== undefined) {
      settings.reflectTriggers = normalizeReflectionTriggers({
        ...settings.reflectTriggers,
        ...input.reflectTriggers,
      })
    }
    if (input.reflectScheduleMode !== undefined) {
      settings.reflectScheduleMode = normalizeReflectionScheduleMode(input.reflectScheduleMode)
      // 亲手选过就钉住：默认值迁移（老存档 daily → version）不能反过来覆盖用户的决定。
      settings.reflectScheduleModePinned = true
    }
    if (input.reflectIntervalMinutes !== undefined) {
      settings.reflectIntervalMinutes = clampReflectionInterval(input.reflectIntervalMinutes)
    }
    if (input.reflectDailyTime !== undefined) {
      settings.reflectDailyTime = normalizeReflectionTime(input.reflectDailyTime)
    }
    if (input.reflectTopics !== undefined) {
      settings.reflectTopics = normalizeReflectionTopics(input.reflectTopics)
    }
    if (input.reflectEmailEnabled !== undefined) {
      // 旧字段只控制反思报告：写它就等于打开/关闭那个事件，其余事件保持原样。
      // 手机端「发送反思邮件」只发这个字段，所以它也要能开总开关；否则用户在手机上
      // 打开开关，电脑端总开关却是关的，信一封都发不出去。
      settings.notifyEmailEnabled = input.reflectEmailEnabled === true
      settings.notifyEmailEvents = withNotifyEvent(
        settings.notifyEmailEvents,
        'reflect.report',
        input.reflectEmailEnabled === true,
      )
      settings.reflectEmailEnabled = input.reflectEmailEnabled === true
    }
    if (input.notifyEmailEnabled !== undefined) {
      settings.notifyEmailEnabled = input.notifyEmailEnabled === true
    }
    if (input.notifyEmailEvents !== undefined) {
      settings.notifyEmailEvents = normalizeNotifyEmailEvents(input.notifyEmailEvents)
      settings.reflectEmailEnabled = settings.notifyEmailEvents.includes('reflect.report')
    }
    // 只剩一个邮箱字段：它同时是收件人、SMTP 登录名与发件人。
    // 旧手机端仍会发 smtpUser / emailFrom，当作同一字段的别名收下，避免升级后改不动配置。
    // 空串与授权码同义：保持原值，只有 null 才清除。旧客户端把没同步好的空表单
    // 原样提交时，不能把用户已经填好的邮箱清掉，否则换一台设备就要重填一次。
    if (input.reflectEmailTo === null) {
      settings.reflectEmailTo = ''
    } else if (input.reflectEmailTo !== undefined) {
      const mailbox = normalizeOptionalText(input.reflectEmailTo, 200)
      if (mailbox) settings.reflectEmailTo = mailbox
    } else if (input.reflectSmtpUser !== undefined || input.reflectEmailFrom !== undefined) {
      const alias = normalizeOptionalText(input.reflectSmtpUser ?? input.reflectEmailFrom ?? '', 200)
      if (alias) settings.reflectEmailTo = alias
    }
    if (input.reflectSmtpHost === null) {
      settings.reflectSmtpHost = ''
    } else if (input.reflectSmtpHost !== undefined) {
      const host = normalizeOptionalText(input.reflectSmtpHost, 200)
      if (host) settings.reflectSmtpHost = host
    }
    if (input.reflectSmtpPort !== undefined) {
      settings.reflectSmtpPort = clampSmtpPort(input.reflectSmtpPort)
    }
    if (input.reflectSmtpSecurity !== undefined) {
      settings.reflectSmtpSecurity = normalizeSmtpSecurity(input.reflectSmtpSecurity)
    }
    if (input.reflectSmtpPassword !== undefined) {
      // 与验证码一致：空串表示保持原值，null 才清除。
      if (input.reflectSmtpPassword === null) hooks.setSmtpPassword(null)
      else if (input.reflectSmtpPassword !== '') hooks.setSmtpPassword(input.reflectSmtpPassword)
    }
    if (input.testTargets !== undefined) {
      settings.testTargets = normalizeTestTargets(input.testTargets)
    }
    if (input.testCaptchaMode !== undefined) {
      settings.testCaptchaMode =
        input.testCaptchaMode === 'fixture' || input.testCaptchaMode === 'header'
          ? input.testCaptchaMode
          : 'off'
    }
    if (input.testCaptcha !== undefined) {
      // 空字符串表示「保持原值」，null 才表示清除，避免密码框留空误删。
      if (input.testCaptcha === null) hooks.setTestCaptcha(null)
      else if (input.testCaptcha !== '') hooks.setTestCaptcha(input.testCaptcha)
    }
    if (input.approvalTimeoutSec !== undefined) {
      settings.approvalTimeoutSec = Math.round(
        clampNumber(input.approvalTimeoutSec, settings.approvalTimeoutSec, 0, 3_600),
      )
    }
    if (input.shellMode !== undefined) settings.shellMode = input.shellMode === true
    if (input.shellInterpreter !== undefined) {
      settings.shellInterpreter =
        validShellInterpreter(input.shellInterpreter) ?? settings.shellInterpreter
    }
    if (input.defaultApprovalMode !== undefined) {
      settings.defaultApprovalMode =
        validApprovalMode(input.defaultApprovalMode) ?? settings.defaultApprovalMode
    }
    if (input.permissionRules !== undefined) {
      settings.permissionRules = sanitizePermissionRules(input.permissionRules)
    }
    if (input.trustedCommands !== undefined) {
      settings.trustedCommands = sanitizeCommandList(input.trustedCommands)
    }
    if (input.classifierModel !== undefined) {
      settings.classifierModel = normalizeText(
        input.classifierModel,
        settings.classifierModel,
        200,
      )
    }
    if (input.reviewModel !== undefined) {
      const value = normalizeOptionalText(input.reviewModel, 200)
      settings.reviewModel = value
      settings.reviewModelId = value
        ? (settings.modelResources.find((resource) => resource.model === value)?.id ?? '')
        : ''
    }
    if (input.sandboxMode !== undefined) {
      settings.sandboxMode = input.sandboxMode === 'auto' ? 'auto' : 'off'
    }
    if (input.sandboxNetwork !== undefined) {
      settings.sandboxNetwork = input.sandboxNetwork !== false
    }
    if (input.sandboxAutoAllow !== undefined) {
      settings.sandboxAutoAllow = input.sandboxAutoAllow !== false
    }
    if (input.allowUnattendedBuild !== undefined) {
      settings.allowUnattendedBuild = input.allowUnattendedBuild === true
    }
    if (input.fullAutonomy !== undefined) {
      settings.fullAutonomy = input.fullAutonomy === true
    }
    if (input.learningMode !== undefined) {
      settings.learningMode = input.learningMode === true
    }
    if (input.learningHosts !== undefined) {
      settings.learningHosts = input.learningHosts
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .slice(0, 64)
    }
    if (input.learningShellIsolation !== undefined) {
      settings.learningShellIsolation = input.learningShellIsolation === true
    }
    if (input.serverMode !== undefined) {
      settings.serverMode = input.serverMode === true
    }
    if (input.serverPort !== undefined) {
      // 端口越界不报错，收敛回默认值：UI 边打字边提交，报错只会打断输入。
      settings.serverPort = normalizeServerPort(input.serverPort, settings.serverPort)
    }
    if (
      input.selfSourceMode !== undefined ||
      input.selfSourceGitUrl !== undefined ||
      input.selfSourceGitRef !== undefined ||
      input.selfSourceGitPath !== undefined ||
      input.selfSourceCustomPath !== undefined
    ) {
      const next = normalizeSelfSourceSettings({
        mode: input.selfSourceMode ?? settings.selfSourceMode,
        gitUrl: input.selfSourceGitUrl ?? settings.selfSourceGitUrl,
        gitRef: input.selfSourceGitRef ?? settings.selfSourceGitRef,
        gitPath: input.selfSourceGitPath ?? settings.selfSourceGitPath,
        customPath: input.selfSourceCustomPath ?? settings.selfSourceCustomPath,
      })
      settings.selfSourceMode = next.mode
      settings.selfSourceGitUrl = next.gitUrl
      settings.selfSourceGitRef = next.gitRef
      settings.selfSourceGitPath = next.gitPath
      settings.selfSourceCustomPath = next.customPath
    }
    if (input.qualityGate !== undefined) {
      settings.qualityGate = input.qualityGate === true
    }
    if (input.qualityPublishTarget !== undefined) {
      settings.qualityPublishTarget = normalizeQualityPublishTarget(
        input.qualityPublishTarget,
      )
    }
    if (input.qualityTuneEvery !== undefined) {
      settings.qualityTuneEvery =
        Number.isFinite(input.qualityTuneEvery) && input.qualityTuneEvery >= 0
          ? Math.min(50, Math.round(input.qualityTuneEvery))
          : 5
    }
    if (input.checkpointRetention !== undefined) {
      settings.checkpointRetention = Math.round(
        clampNumber(
          input.checkpointRetention,
          settings.checkpointRetention,
          5,
          100,
        ),
      )
    }
    if (input.checkpointMaxBytes !== undefined) {
      settings.checkpointMaxBytes = Math.round(
        clampNumber(
          input.checkpointMaxBytes,
          settings.checkpointMaxBytes,
          512 * 1024 * 1024,
          20 * 1024 * 1024 * 1024,
        ),
      )
    }
    if (input.checkpointShell !== undefined) {
      settings.checkpointShell = input.checkpointShell !== false
    }
    if (input.checkpointIgnore !== undefined) {
      settings.checkpointIgnore = normalizeCheckpointIgnore(input.checkpointIgnore)
    }
    if (input.checkpointScope !== undefined) {
      settings.checkpointScope = normalizeCheckpointScope(input.checkpointScope)
    }
    if (input.notifyDesktop !== undefined) {
      settings.notifyDesktop = input.notifyDesktop !== false
    }
    if (input.hooksEnabled !== undefined) {
      settings.hooksEnabled = input.hooksEnabled === true
    }
    if (input.mcpEnabled !== undefined) {
      settings.mcpEnabled = input.mcpEnabled === true
    }
    if (input.relayUrl !== undefined) {
      const normalized = normalizeRelayUrl(input.relayUrl)
      if (normalized === null) {
        throw new Error(
          '中继地址必须是 wss:// 或 ws:// 地址，可带 #k=准入码，且不能包含用户名或密码。',
        )
      }
      settings.relayUrl = normalized
    }
    if (input.theme !== undefined) {
      settings.theme = validTheme(input.theme) ?? settings.theme
    }
    if (input.fontSize !== undefined) {
      settings.fontSize = validFontSize(input.fontSize) ?? settings.fontSize
    }
    if (input.locale !== undefined) {
      settings.locale = isLocaleSetting(input.locale)
        ? input.locale
        : settings.locale
    }
    if (input.apiKey !== undefined) hooks.setApiKey(input.apiKey || null)
}
