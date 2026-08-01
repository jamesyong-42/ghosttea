import GhostteaTruffle
import SwiftUI

/// The §8.1 banner vocabulary on iOS: docked to the top of the pane, never
/// modal, and never covering the frozen screen it is explaining.
struct GhostteaAttachmentBannerView: View {
  let banner: GhostteaAttachmentBanner
  let onAction: (GhostteaAttachmentBannerAction) -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: icon)
        .foregroundStyle(tint)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(banner.title)
          .font(.callout.weight(.medium))
        if let detail = banner.detail {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            // The countdown and the honest contact clock both change every
            // second; animating each one draws the eye to a number that is
            // deliberately unremarkable.
            .animation(nil, value: detail)
        }
      }
      Spacer(minLength: 0)
      ForEach(banner.actions, id: \.self) { action in
        Button(label(for: action)) { onAction(action) }
          .buttonStyle(.bordered)
          .controlSize(.small)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.thinMaterial)
    // One live region for the whole banner: a screen reader should hear "lost
    // — reconnecting, last contact 12 seconds ago", not two unrelated updates.
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.updatesFrequently)
  }

  private var icon: String {
    switch banner.kind {
    case .reconnecting: "arrow.trianglehead.2.clockwise.rotate.90"
    case .synchronizing: "arrow.down.circle"
    case .resumed: "checkmark.circle.fill"
    case .suspended: "pause.circle"
    case .ended: "xmark.circle"
    }
  }

  private var tint: Color {
    switch banner.kind {
    case .reconnecting, .synchronizing: .orange
    case .resumed: .green
    case .suspended: .secondary
    case .ended: .red
    }
  }

  private func label(for action: GhostteaAttachmentBannerAction) -> String {
    switch action {
    case .retryNow: "Retry now"
    case .resume: "Resume"
    case .browseSessions: "Browse sessions"
    case .close: "Close"
    }
  }
}

/// The dropped-keystroke note (§4.3). Non-blocking and self-dismissing: it
/// reports what already happened, so there is nothing to acknowledge.
struct GhostteaAttachmentInputCueView: View {
  let cue: GhostteaAttachmentInputCue

  var body: some View {
    Text(cue.text)
      .font(.caption)
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .background(.thinMaterial, in: Capsule())
      .accessibilityElement()
      .accessibilityLabel(cue.text)
  }
}
