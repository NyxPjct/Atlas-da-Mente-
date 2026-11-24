package br.com.atlasdamente;

import java.net.URI;
import java.util.Locale;

final class ServerAddress {
    private ServerAddress() {}

    static String normalize(String input) {
        if (input == null || input.length() > 512) throw invalid();
        try {
            URI url = URI.create(input.trim());
            String scheme = url.getScheme().toLowerCase(Locale.ROOT);
            String host = url.getHost().toLowerCase(Locale.ROOT);
            String path = url.getPath();
            int port = url.getPort();
            if (!("https".equals(scheme) || ("http".equals(scheme) && localHost(host)))
                || url.getUserInfo() != null || url.getQuery() != null || url.getFragment() != null
                || (!path.isEmpty() && !path.equals("/")) || port == 0 || port > 65535) throw invalid();
            int defaultPort = scheme.equals("https") ? 443 : 80;
            return scheme + "://" + host + (port == -1 || port == defaultPort ? "" : ":" + port);
        } catch (NullPointerException | IllegalArgumentException error) {
            throw invalid();
        }
    }

    static boolean sameOrigin(String trusted, String value) {
        try {
            URI url = URI.create(value);
            if (url.getUserInfo() != null) return false;
            return trusted != null && trusted.equals(normalize(url.getScheme() + "://" + url.getRawAuthority()));
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static boolean localHost(String host) {
        if ("localhost".equals(host) || "[::1]".equals(host)) return true;
        if (!host.matches("(0|[1-9][0-9]{0,2})(\\.(0|[1-9][0-9]{0,2})){3}")) return false;
        String[] parts = host.split("\\.");
        for (String part : parts) if (Integer.parseInt(part) > 255) return false;
        int first = Integer.parseInt(parts[0]);
        int second = Integer.parseInt(parts[1]);
        return first == 10 || first == 127 || (first == 192 && second == 168) || (first == 172 && second >= 16 && second <= 31);
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Use HTTPS, ou o endereço HTTP de uma rede local para a demonstração.");
    }
}
