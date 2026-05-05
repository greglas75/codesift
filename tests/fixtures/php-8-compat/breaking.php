<?php
// Mixed bag of PHP 8 breaking changes for the gating audit fixture.

// 1. each() — removed in 8.0
$arr = ['a' => 1, 'b' => 2];
while (list($k, $v) = each($arr)) {
    echo "$k=$v\n";
}

// 2. create_function — removed in 8.0
$double = create_function('$x', 'return $x * 2;');

// 3. (real) cast — removed in 8.0
$f = (real)"3.14";

// 4. money_format — removed in 8.0
$display = money_format('%n', 1234.56);

// 5. array_key_exists on object — TypeError in 8.0
$exists = array_key_exists('foo', $userObject);
$exists2 = array_key_exists('bar', $itemModel);

// 6. PHP 8.1 deprecation: null to non-nullable string param
$pos = strpos($haystack, null);
$len = strlen(null);
$out = trim(null);

// 7. utf8_encode/utf8_decode — deprecated 8.2
$utf = utf8_encode($latin1);
$lat = utf8_decode($utf8);

// 8. Spread operator on string-keyed (heuristic — we look at variable names)
function bar(...$config) {
    foo(...$config);
}

// 9. is_resource on closed
$gd = imagecreate(10, 10);
imagedestroy($gd);
if (is_resource($gd)) {
    echo "still resource";
}
