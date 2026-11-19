import SwiftUI

/// The first tab's Code mode until code sessions from the desktop arrive: an empty state and a
/// composer that can't send yet.
struct CodePlaceholderView: View {
    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 12) {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.system(size: 40))
                        .foregroundColor(Theme.textMuted)
                        .accessibilityHidden(true)
                    Text("No code sessions yet")
                        .font(.headline)
                        .foregroundColor(Theme.textSecondary)
                    Text(CodeCopy.emptyState)
                        .font(.callout)
                        .foregroundColor(Theme.textMuted)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 32)
                .padding(.vertical, 48)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
            }
            .frame(maxHeight: .infinity)

            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask your computer to code...", text: .constant(""), axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.body)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.bgInput)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(Theme.borderStrong, lineWidth: 0.5)
                    )
                    .disabled(true)
                    .accessibilityHint("Not available yet. Turn on Code from your phone in the EdgeCoder desktop app.")
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(Theme.textMuted)
                    .accessibilityHidden(true)
            }
            .opacity(0.6)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.bgBase)
            .overlay(alignment: .top) {
                Rectangle().fill(Theme.border).frame(height: 0.5)
            }
        }
        .background(Theme.bgBase)
    }
}
