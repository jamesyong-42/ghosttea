# App Store submission notes

**Status:** draft; account-owner approval and review access are required

**Policy review date:** 2026-07-18

## What Ghosttea does

Ghosttea is a general-purpose terminal client in the Developer Tools category.
It supports two user-initiated connection modes:

1. direct SSH to a host chosen and authenticated by the user; and
2. attachment to a terminal session already running in the user's Ghosttea
   desktop app over the user's private Tailscale network.

Shells, commands, terminal applications, and downloaded command output execute
on the remote computer. The iOS application decodes terminal protocol bytes,
renders them with its bundled terminal engine, and sends user input. It does not
download or execute new native, JavaScript, WebAssembly, or interpreted program
code inside the iOS application. It does not present a software catalog,
storefront, or purchasing flow.

## Reviewer access to prepare

Before submission, replace this section with working, time-bounded review
instructions and verify them from a clean device:

- a user-owned SSH fixture host, port, username, authentication method, and
  harmless verification command;
- a paired Ghosttea desktop fixture visible through the supplied Tailscale test
  identity, with one running terminal session;
- exact steps for direct SSH, shared-session attachment, keyboard input,
  disconnect, and reconnect; and
- a support contact able to keep both fixtures available throughout review.

Never commit fixture passwords, private keys, Tailscale login secrets, or
recovery codes. Supply them only through App Store Connect review notes.

## Privacy and credentials

SSH passwords, private keys, and passphrases are stored as device-only,
non-synchronizing Keychain items. Saved profiles and workspace restoration
contain opaque credential references, not secret material. Direct SSH traffic
goes only to the host selected by the user. Shared-session traffic uses the
user's Tailscale account and private network.

The app contains no advertising or tracking SDK. Before release, the account
owner must reconcile the data transmitted to and retained by Tailscale's
control plane with the App Store privacy label, publish a privacy policy, and
make that policy reachable both in App Store Connect and inside the app. Until
then, the release gate remains blocked.

## Encryption export compliance

The app embeds OpenSSL, libssh2, and TailscaleKit and therefore declares
`ITSAppUsesNonExemptEncryption=YES`. Do not change this to `NO` merely to bypass
App Store Connect questions. The account owner must complete Apple's encryption
determination, upload any required documentation, and add an approved compliance
code when Apple supplies one.

## Background behavior

The app does not claim indefinite background terminal execution. When iOS
suspends the app, active work is suspended and later restored or reconnected
through explicit lifecycle state. Long-lived remote work is expected to run in
tmux, Zellij, or the desktop-hosted Ghosttea session.

## Durable Apple references

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)
- [Required-reason APIs](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)
- [App privacy details](https://developer.apple.com/app-store/app-privacy-details/)
- [Export compliance overview](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)
