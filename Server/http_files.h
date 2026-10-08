// http_files.h — Tiny static file responder.
//
// The same process that hosts the game also serves `public/`, so playing is a
// single command instead of "run the server, then remember to start a web
// server somewhere else". This is deliberately minimal: GET only, no ranges,
// no caching, no compression, and a strict path check because the request
// comes straight off the network.

#ifndef CRASHBALL_HTTP_FILES_H
#define CRASHBALL_HTTP_FILES_H

#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

namespace httpfiles {

// Directory that contains index.html. Probed at startup so the server works
// whether it is launched from the project root, from build/, or from an IDE.
//
// PUBLIC_DIR overrides the probing. It exists because inside a container the
// working directory is fixed and the relative paths above do not apply; without
// it the server starts and then serves nothing, which looks exactly like a
// broken deployment.
inline std::string findPublicDir() {
    if (const char* configured = std::getenv("PUBLIC_DIR")) {
        if (configured[0] != '\0') {
            std::ifstream probe(std::string(configured) + "/index.html",
                                std::ios::binary);
            return probe.good() ? std::string(configured) : std::string();
        }
    }

    static const char* kCandidates[] = {
        "public",
        "../public",
        "../../public",
        "space-ball/public",
    };

    for (const char* candidate : kCandidates) {
        std::ifstream probe(std::string(candidate) + "/index.html",
                            std::ios::binary);
        if (probe.good()) return candidate;
    }
    return std::string();
}

inline std::string contentType(const std::string& path) {
    const size_t dot = path.find_last_of('.');
    const std::string ext =
        (dot == std::string::npos) ? std::string() : path.substr(dot);

    if (ext == ".html" || ext == ".htm") return "text/html; charset=utf-8";
    if (ext == ".js")   return "text/javascript; charset=utf-8";
    if (ext == ".css")  return "text/css; charset=utf-8";
    if (ext == ".json") return "application/json; charset=utf-8";
    if (ext == ".png")  return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".svg")  return "image/svg+xml";
    if (ext == ".ico")  return "image/x-icon";
    if (ext == ".woff2") return "font/woff2";
    return "application/octet-stream";
}

// Extracts the request target from "GET /path HTTP/1.1".
inline std::string requestPath(const std::string& header) {
    const size_t firstSpace = header.find(' ');
    if (firstSpace == std::string::npos) return std::string();

    const size_t secondSpace = header.find(' ', firstSpace + 1);
    if (secondSpace == std::string::npos) return std::string();

    std::string target = header.substr(firstSpace + 1, secondSpace - firstSpace - 1);

    const size_t query = target.find('?');
    if (query != std::string::npos) target.resize(query);

    // Percent-decode.
    std::string decoded;
    decoded.reserve(target.size());
    for (size_t i = 0; i < target.size(); ++i) {
        if (target[i] == '%' && i + 2 < target.size()) {
            const auto hex = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            };
            const int hi = hex(target[i + 1]);
            const int lo = hex(target[i + 2]);
            if (hi < 0 || lo < 0) return std::string();
            decoded.push_back(static_cast<char>((hi << 4) | lo));
            i += 2;
        } else {
            decoded.push_back(target[i]);
        }
    }

    // Reject anything that could escape the public directory, plus control
    // bytes and NULs smuggled in through percent-encoding.
    if (decoded.find("..") != std::string::npos) return std::string();
    if (decoded.find('\\') != std::string::npos) return std::string();
    if (decoded.find(':') != std::string::npos) return std::string();
    for (unsigned char c : decoded) {
        if (c < 0x20 || c == 0x7F) return std::string();
    }
    return decoded;
}

// Builds the complete HTTP response for a request. On any failure it produces
// a 404, which is also what unknown paths get.
inline std::string buildResponse(const std::string& publicDir,
                                 const std::string& header) {
    std::string notFound =
        "HTTP/1.1 404 Not Found\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "Content-Length: 9\r\n"
        "Connection: keep-alive\r\n\r\nNot Found";

    if (publicDir.empty()) return notFound;

    std::string path = requestPath(header);
    if (path.empty()) return notFound;
    if (path == "/") path = "/index.html";

    const std::string fullPath = publicDir + path;

    std::ifstream file(fullPath, std::ios::binary);
    if (!file.good()) return notFound;

    const std::vector<char> raw((std::istreambuf_iterator<char>(file)),
                                std::istreambuf_iterator<char>());

    std::string response =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: " + contentType(fullPath) + "\r\n"
        "Content-Length: " + std::to_string(raw.size()) + "\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: keep-alive\r\n\r\n";
    response.append(raw.begin(), raw.end());
    return response;
}

}  // namespace httpfiles

#endif  // CRASHBALL_HTTP_FILES_H
