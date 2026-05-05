<?php
return [
    'components' => [
        'urlManager' => [
            'enablePrettyUrl' => true,
            'rules' => [
                'GET api/posts' => 'post/index',
                'GET api/posts/<id:\d+>' => 'post/view',
                'POST api/posts' => 'post/create',
                'home' => 'site/index',
            ],
        ],
    ],
];
