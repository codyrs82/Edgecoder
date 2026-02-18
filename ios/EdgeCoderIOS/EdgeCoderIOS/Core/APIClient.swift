import Foundation

enum APIClientError: LocalizedError {
    case invalidURL
    case invalidResponse
    case serverError(String)
    case decodingError
    case timeout

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL."
        case .invalidResponse:
            return "Invalid server response."
        case .serverError(let error):
            return error
        case .decodingError:
            return "Could not decode response."
        case .timeout:
            return "Request timed out. Check network and try again."
        }
    }
}

final class APIClient {
    static let shared = APIClient(config: .current)

    let config: AppConfig
    private let session: URLSession

    init(config: AppConfig) {
        self.config = config
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.httpCookieStorage = .shared
        sessionConfig.httpShouldSetCookies = true
        sessionConfig.httpCookieAcceptPolicy = .always
        sessionConfig.requestCachePolicy = .reloadIgnoringLocalCacheData
        sessionConfig.timeoutIntervalForRequest = 15
        sessionConfig.timeoutIntervalForResource = 30
        sessionConfig.waitsForConnectivity = false
        self.session = URLSession(configuration: sessionConfig)
    }

    func request<T: Decodable>(
        baseURL: URL,
        path: String,
        method: String = "GET",
        body: Encodable? = nil
    ) async throws -> T {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = true
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let body {
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }

        let timeoutNanos = UInt64(request.timeoutInterval * 1_000_000_000)
        let (data, response): (Data, URLResponse) = try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
            group.addTask { [session] in
                try await session.data(for: request)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNanos)
                throw APIClientError.timeout
            }
            guard let first = try await group.next() else {
                throw APIClientError.invalidResponse
            }
            group.cancelAll()
            return first
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }

        if !(200...299).contains(http.statusCode) {
            if let server = try? JSONDecoder().decode([String: String].self, from: data),
               let error = server["error"] {
                throw APIClientError.serverError(error)
            }
            throw APIClientError.serverError("Server returned \(http.statusCode).")
        }

        if T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }

        guard !data.isEmpty else {
            throw APIClientError.decodingError
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIClientError.decodingError
        }
    }
}

struct EmptyResponse: Decodable {}

struct AnyEncodable: Encodable {
    private let encodeImpl: (Encoder) throws -> Void
    init(_ wrapped: Encodable) {
        self.encodeImpl = { encoder in
            try wrapped.encode(to: encoder)
        }
    }
    func encode(to encoder: Encoder) throws {
        try encodeImpl(encoder)
    }
}
