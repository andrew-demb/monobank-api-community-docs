# Monobank API community docs

![logo](https://user-images.githubusercontent.com/59166229/211002581-faa622e4-d47f-4c93-9d9d-afce50484339.png)

Most of the information in the current repository will be specific to Monobank
open API.

For other APIs, see information [below](#other-api).

> The information is structured by the Monobank API user community
> practical experience of using or feedback from Monobank representatives
> Telegram chat community (the link to the chat is available on the API documentation page)

## API

Monobank Open API - an API that is publicly available (without authentication) or to bank clients using an authentication token,
or service providers.

Link to Monobank Open API documentation:

- general https://api.monobank.ua/docs/
- corporate API for service providers https://api.monobank.ua/docs/corporate.html

This part of the API is developed by only one Monobank developer on his own initiative and is engaged in its development
in free time. From which it follows that the possibilities of its expansion or support on issues are quite limited.

For many reasons, the Open API provides the possibility to use only "Read-only" operations.
There are no transactions to form or change customer data.

Only the developer can provide _absolutely accurate and comprehensive_ information about this API.

### Enterprise API for service providers

"Production" access to the API is granted after confirming the request sent via the API:
https://api.monobank.ua/docs/corporate.html#tag/Avtorizaciya-ta-nalashtuvannya-kompaniyi/paths/~1personal~1auth~1registration/post

## Telegram API community

Telegram has created a chat for the Monobank Open API user community for the following:
- providing feedback on the use of the API;
- mutual assistance of users on API usage issues;

To preserve the balance of useful information in the chat and save the time of other chat participants, it is considered a good tone:
- do not use the chat as a freelance exchange;
- do not use the chat as a "circle of programmers";
- discuss topics closely related to the use of Monobank Open API;
- respect the time of others and familiarize yourself with the information provided here, in pinned chat messages, documentation.

> A chat link is available on the API documentation page.

## Troubleshooting

### 1. Error when calling the API - 403 status code with HTML in the response body

If you receive a 403 error when working with the API, you have most likely been blocked by AWS
(which "protects" the API from malicious attacks).

Unfortunately, neither the developers nor the community can help with unlocking.

The response body may look like this:
```
  <html>
     <head>
       <title>403 Forbidden</title>
     </head>
    
     <body>
       <center>
         <h1>403 Forbidden</h1>
       </center>
     </body>
</html>
```

## Other APIs

Monobank has not only an open API, but also others:
1. Internet acquiring
2. Purchase in parts
3. Expirenza by mono (shaketopay)

You can contact Monobank employees for advice on these services
according to the communication channels provided on the landing pages of the services.

### 1. Internet acquiring (acquiring)

Link to the landing page of the service: https://monobank.ua/e-comm

Link to documentation: https://api.monobank.ua/docs/acquiring.html

The official WordPress module from Monobank for connecting online acquiring: https://uk.wordpress.org/plugins/monopay/

### 2. Purchase in parts

Link to the landing page of the service: https://chast.monobank.ua/vendors

Documentation link: https://u2-demo-ext.mono.st4g3.com/docs/index.html

### 3. Expirenza by mono (shaketopay)

Link to the landing page of the service: https://shaketopay.com.ua/

Documentation link: https://api.shaketopay.com.ua/
