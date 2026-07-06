package br.com.marketme.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Casca nativa mínima do MarketMe: um WebView em tela cheia que carrega a
 * SPA empacotada em assets/www. Sem AndroidX/Gradle de propósito — o APK é
 * montado direto com aapt + dx + apksigner (ver build.sh).
 */
public class MainActivity extends Activity {

    private static final int REQ_CAMERA = 1;
    private WebView webView;
    private PermissionRequest pendingWebPermission;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);            // localStorage (configurações do app)
        s.setAllowFileAccess(true);
        // A SPA roda em file:// e chama a API em http://<servidor>:3000.
        // Sem isto o WebView bloquearia o fetch por CORS/conteúdo misto.
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // navegação fica dentro do app
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (hasCameraPermission()) {
                            request.grant(request.getResources());
                        } else {
                            pendingWebPermission = request;
                            requestPermissions(
                                new String[] { Manifest.permission.CAMERA }, REQ_CAMERA);
                        }
                    }
                });
            }
        });

        webView.loadUrl("file:///android_asset/www/index.html");
    }

    private boolean hasCameraPermission() {
        return checkSelfPermission(Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_CAMERA && pendingWebPermission != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                pendingWebPermission.grant(pendingWebPermission.getResources());
            } else {
                pendingWebPermission.deny();
            }
            pendingWebPermission = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
