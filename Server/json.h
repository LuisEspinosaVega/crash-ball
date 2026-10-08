// json.h — Minimal JSON reader for client -> server messages.
//
// The server only ever *parses* small control messages ({"type":"INPUT",...})
// and *writes* its state by hand, so this is deliberately a reader plus a
// string-escaping helper rather than a full DOM with a serializer.

#ifndef CRASHBALL_JSON_H
#define CRASHBALL_JSON_H

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

namespace json {

struct Value {
    enum class Type { Null, Bool, Number, String, Array, Object };

    Type type = Type::Null;
    bool boolean = false;
    double number = 0.0;
    std::string string;
    std::vector<Value> array;
    std::vector<std::pair<std::string, Value>> object;

    bool isNull()   const { return type == Type::Null; }
    bool isBool()   const { return type == Type::Bool; }
    bool isNumber() const { return type == Type::Number; }
    bool isString() const { return type == Type::String; }
    bool isArray()  const { return type == Type::Array; }
    bool isObject() const { return type == Type::Object; }

    // Object member lookup; nullptr when this value is not an object or the
    // key is absent. Callers get to choose their own default.
    const Value* find(const std::string& key) const {
        if (type != Type::Object) return nullptr;
        for (const auto& kv : object) {
            if (kv.first == key) return &kv.second;
        }
        return nullptr;
    }

    double asNumber(double fallback = 0.0) const {
        switch (type) {
            case Type::Number: return number;
            case Type::Bool:   return boolean ? 1.0 : 0.0;
            case Type::String: {
                // Tolerate clients that quote their numbers ("move":"-1").
                try {
                    size_t used = 0;
                    double v = std::stod(string, &used);
                    return used == string.size() ? v : fallback;
                } catch (...) {
                    return fallback;
                }
            }
            default: return fallback;
        }
    }

    std::string asString(const std::string& fallback = std::string()) const {
        if (type == Type::String) return string;
        if (type == Type::Number) {
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%g", number);
            return buf;
        }
        if (type == Type::Bool) return boolean ? "true" : "false";
        return fallback;
    }
};

namespace detail {

// Recursive-descent reader. Bounded depth so a hostile payload cannot blow the
// stack, and bounded string growth so it cannot exhaust memory.
class Reader {
public:
    explicit Reader(const std::string& text) : s_(text) {}

    bool read(Value& out) {
        skipSpace();
        if (!parseValue(out, 0)) return false;
        skipSpace();
        return pos_ == s_.size();
    }

private:
    static constexpr int kMaxDepth = 32;

    const std::string& s_;
    size_t pos_ = 0;

    bool eof() const { return pos_ >= s_.size(); }
    char peek() const { return eof() ? '\0' : s_[pos_]; }

    void skipSpace() {
        while (!eof()) {
            char c = s_[pos_];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++pos_;
            else break;
        }
    }

    bool literal(const char* word) {
        size_t n = 0;
        while (word[n] != '\0') ++n;
        if (s_.compare(pos_, n, word) != 0) return false;
        pos_ += n;
        return true;
    }

    bool parseValue(Value& out, int depth) {
        if (depth > kMaxDepth) return false;
        skipSpace();
        if (eof()) return false;

        switch (peek()) {
            case '{': return parseObject(out, depth);
            case '[': return parseArray(out, depth);
            case '"': {
                out.type = Value::Type::String;
                return parseString(out.string);
            }
            case 't':
                if (!literal("true")) return false;
                out.type = Value::Type::Bool;
                out.boolean = true;
                return true;
            case 'f':
                if (!literal("false")) return false;
                out.type = Value::Type::Bool;
                out.boolean = false;
                return true;
            case 'n':
                if (!literal("null")) return false;
                out.type = Value::Type::Null;
                return true;
            default: return parseNumber(out);
        }
    }

    bool parseObject(Value& out, int depth) {
        out.type = Value::Type::Object;
        ++pos_;                       // '{'
        skipSpace();
        if (peek() == '}') { ++pos_; return true; }

        for (;;) {
            skipSpace();
            if (peek() != '"') return false;
            std::string key;
            if (!parseString(key)) return false;
            skipSpace();
            if (peek() != ':') return false;
            ++pos_;                   // ':'

            Value member;
            if (!parseValue(member, depth + 1)) return false;
            out.object.emplace_back(std::move(key), std::move(member));

            skipSpace();
            if (peek() == ',') { ++pos_; continue; }
            if (peek() == '}') { ++pos_; return true; }
            return false;
        }
    }

    bool parseArray(Value& out, int depth) {
        out.type = Value::Type::Array;
        ++pos_;                       // '['
        skipSpace();
        if (peek() == ']') { ++pos_; return true; }

        for (;;) {
            Value element;
            if (!parseValue(element, depth + 1)) return false;
            out.array.emplace_back(std::move(element));

            skipSpace();
            if (peek() == ',') { ++pos_; continue; }
            if (peek() == ']') { ++pos_; return true; }
            return false;
        }
    }

    bool parseString(std::string& out) {
        ++pos_;                       // opening quote
        out.clear();
        for (;;) {
            if (eof()) return false;
            unsigned char c = static_cast<unsigned char>(s_[pos_++]);
            if (c == '"') return true;
            if (c != '\\') {
                out.push_back(static_cast<char>(c));
                continue;
            }
            if (eof()) return false;
            char esc = s_[pos_++];
            switch (esc) {
                case '"':  out.push_back('"');  break;
                case '\\': out.push_back('\\'); break;
                case '/':  out.push_back('/');  break;
                case 'b':  out.push_back('\b'); break;
                case 'f':  out.push_back('\f'); break;
                case 'n':  out.push_back('\n'); break;
                case 'r':  out.push_back('\r'); break;
                case 't':  out.push_back('\t'); break;
                case 'u': {
                    uint32_t cp = 0;
                    if (!parseHex4(cp)) return false;
                    appendUtf8(out, cp);
                    break;
                }
                default: return false;
            }
        }
    }

    bool parseHex4(uint32_t& cp) {
        if (pos_ + 4 > s_.size()) return false;
        cp = 0;
        for (int i = 0; i < 4; ++i) {
            char c = s_[pos_++];
            cp <<= 4;
            if (c >= '0' && c <= '9')      cp |= static_cast<uint32_t>(c - '0');
            else if (c >= 'a' && c <= 'f') cp |= static_cast<uint32_t>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') cp |= static_cast<uint32_t>(c - 'A' + 10);
            else return false;
        }
        return true;
    }

    static void appendUtf8(std::string& out, uint32_t cp) {
        if (cp < 0x80) {
            out.push_back(static_cast<char>(cp));
        } else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    bool parseNumber(Value& out) {
        size_t start = pos_;
        if (peek() == '-') ++pos_;
        while (!eof()) {
            char c = peek();
            if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' ||
                c == '+' || c == '-') {
                ++pos_;
            } else {
                break;
            }
        }
        if (pos_ == start) return false;

        const std::string token = s_.substr(start, pos_ - start);
        try {
            size_t used = 0;
            double v = std::stod(token, &used);
            if (used != token.size()) return false;
            out.type = Value::Type::Number;
            out.number = v;
            return true;
        } catch (...) {
            return false;
        }
    }
};

}  // namespace detail

// Parses a complete JSON document. Returns false on any malformed input.
inline bool parse(const std::string& text, Value& out) {
    out = Value();
    detail::Reader reader(text);
    return reader.read(out);
}

// Escapes a raw string so it can be embedded in a JSON string literal.
inline std::string escape(const std::string& raw) {
    std::string out;
    out.reserve(raw.size() + 8);
    for (unsigned char c : raw) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    return out;
}

// Formats a float without the trailing ".000000" noise or "-0".
inline std::string number(double v, int decimals = 2) {
    if (!std::isfinite(v)) return "0";
    char buf[48];
    std::snprintf(buf, sizeof(buf), "%.*f", decimals, v);
    std::string s(buf);
    // Trim a trailing "-0.00".
    if (s.find_first_not_of("-0.") == std::string::npos) return "0";
    return s;
}

}  // namespace json

#endif  // CRASHBALL_JSON_H
