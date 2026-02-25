import SwiftUI

struct MessageBubble: View {
    let message: ChatMessage
    var streaming: Bool = false
    var progress: StreamProgress?

    @State private var verb = StreamProgress.randomVerb()
    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.role == .user {
                Spacer(minLength: 60)
            }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
                // Content
                if message.role == .assistant {
                    assistantContent
                } else {
                    Text(message.content)
                        .font(.body)
                        .foregroundColor(Theme.textPrimary)
                }

                // Streaming progress indicator
                if streaming {
                    streamingProgressView
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(bubbleBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

            if message.role == .assistant {
                Spacer(minLength: 40)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 3)
    }

    // MARK: - Streaming Progress

    private var streamingProgressView: some View {
        HStack(spacing: 6) {
            // Pulsing dot
            Circle()
                .fill(Theme.accent)
                .frame(width: 6, height: 6)
                .opacity(pulseOpacity)
                .onAppear {
                    withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                        pulseOpacity = 0.3
                    }
                }

            // Verb
            Text("\(verb)…")
                .font(.caption)
                .foregroundColor(Theme.textMuted)

            if let p = progress {
                // Elapsed time
                let seconds = p.elapsedMs / 1000
                Text("(\(seconds)s")
                    .font(.caption)
                    .foregroundColor(Theme.textMuted)

                // Token count
                Text("· \u{2191} \(p.tokenCount) tokens")
                    .font(.caption)
                    .foregroundColor(Theme.textMuted)

                // Route info
                if !p.routeLabel.isEmpty {
                    Text("·")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                    Image(systemName: p.routeIcon)
                        .font(.caption2)
                        .foregroundColor(Theme.textMuted)
                    Text("\(p.routeLabel))")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                }  else {
                    Text(")")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                }

                if let credits = p.creditsSpent {
                    Text("· \(String(format: "%.1f", credits)) cr")
                        .font(.caption)
                        .foregroundColor(Theme.accent)
                }
            }
        }
        .padding(.top, 4)
    }

    // MARK: - Assistant content with code blocks

    @ViewBuilder
    private var assistantContent: some View {
        let segments = parseContent(message.content)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(segments.indices, id: \.self) { i in
                switch segments[i] {
                case .text(let text):
                    Text(text)
                        .font(.body)
                        .foregroundColor(Theme.textPrimary)
                case .code(let code, let lang):
                    codeBlock(code: code, language: lang)
                }
            }
        }
    }

    private func codeBlock(code: String, language: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.caption2)
                    .foregroundColor(Theme.textMuted)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "doc.on.doc")
                            .font(.caption2)
                        Text("Copy")
                            .font(.caption2)
                    }
                    .foregroundColor(Theme.textSecondary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Theme.bgDeep)

            // Code
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(Theme.textPrimary)
                    .padding(10)
            }
            .background(Theme.bgInput)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Theme.border, lineWidth: 0.5)
        )
    }

    private var bubbleBackground: Color {
        switch message.role {
        case .user:
            return Theme.accent.opacity(0.9)
        case .assistant:
            return Theme.bgSurface
        case .system:
            return Theme.bgElevated
        }
    }

    // MARK: - Content Parsing

    private enum ContentSegment {
        case text(String)
        case code(String, String) // code, language
    }

    private func parseContent(_ content: String) -> [ContentSegment] {
        var segments: [ContentSegment] = []
        let pattern = "```(\\w*)\\n([\\s\\S]*?)```"
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return [.text(content)]
        }

        let nsContent = content as NSString
        let matches = regex.matches(in: content, range: NSRange(location: 0, length: nsContent.length))

        if matches.isEmpty {
            return [.text(content)]
        }

        var lastEnd = 0
        for match in matches {
            let matchRange = match.range
            if matchRange.location > lastEnd {
                let textBefore = nsContent.substring(with: NSRange(location: lastEnd, length: matchRange.location - lastEnd))
                let trimmed = textBefore.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    segments.append(.text(trimmed))
                }
            }
            let lang = match.numberOfRanges > 1 ? nsContent.substring(with: match.range(at: 1)) : ""
            let code = match.numberOfRanges > 2 ? nsContent.substring(with: match.range(at: 2)).trimmingCharacters(in: .newlines) : ""
            segments.append(.code(code, lang))
            lastEnd = matchRange.location + matchRange.length
        }

        if lastEnd < nsContent.length {
            let remaining = nsContent.substring(from: lastEnd).trimmingCharacters(in: .whitespacesAndNewlines)
            if !remaining.isEmpty {
                segments.append(.text(remaining))
            }
        }

        return segments
    }
}
