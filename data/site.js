// All site content lives here so it can be edited without touching templates.

export const contact = {
  editor: { name: 'Mr. John Wagstaff', role: 'Editor of the Beckenham Historian', email: 'john.wagstaff176@gmail.com' },
  programme: { name: 'Mrs. Ann Wagstaff', role: 'Programme Secretary', email: 'john.wagstaff176@gmail.com' },
  general: { name: 'Mrs. Ann Wagstaff', role: 'Programme Secretary', email: 'ann.wagstaff@beckenham-historical-association.org' },
  postal: 'Mr. J. S. Wagstaff, 182 Devonshire Way, Shirley, Croydon, CR0 8BX',
  twitter: 'https://twitter.com/BeckenhamHA',
};

export const venue = {
  name: 'Christ Church Hall',
  address: 'Fairfield Road, just off Beckenham High Street, Beckenham BR3 3LE',
  // Plain postal form for calendars, so tapping it opens the right place in a maps app.
  postalAddress: 'Fairfield Road, Beckenham BR3 3LE',
  mapEmbed:
    'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2488.791557654804!2d-0.029101123771392914!3d51.406884571790634!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x487601befe451075%3A0x37fbf47e911dfe7f!2sChrist%20Church%20Beckenham!5e0!3m2!1sen!2suk!4v1720013248747!5m2!1sen!2suk',
};

// The events programme lives in content/events.txt.

export const links = [
  { name: 'Ripley Arts Centre', url: 'http://www.bromleyarts.com/', description: 'Website for a flourishing arts centre which has over one hundred affiliated arts organisations.' },
  { name: 'Beckenham History', url: 'http://www.beckenhamhistory.co.uk/', description: 'An important and evolving website for those interested in the history of Beckenham.' },
  { name: 'Beckenham Net', url: 'http://www.beckenham.net/', description: 'Informative site for the town in which we hold our meetings.' },
  { name: 'Bromley Signpost', url: 'http://www.bromley.gov.uk/', description: 'Excellent official London Borough of Bromley site.' },
];

// Public-domain images from Wikimedia Commons.
export const images = {
  highStreet: { src: '/images/high-street-1900.jpg', caption: 'Beckenham High Street, c. 1900', source: 'https://commons.wikimedia.org/wiki/File:BeckenhamI.jpg' },
  flood: { src: '/images/beckenham-1878.jpg', caption: 'The flood at Beckenham, 10 April 1878', source: 'https://commons.wikimedia.org/wiki/File:Beckenham2.jpg' },
  churchHill: { src: '/images/church-hill-1906.jpg', caption: 'Church Hill and the High Street, posted 1906', source: 'https://commons.wikimedia.org/wiki/File:Early_Postcard_of_Church_Hill,_Beckenham,_London._Posted_1906._(50272058858).jpg' },
  hospital: { src: '/images/cottage-hospital.jpg', caption: 'Beckenham Cottage Hospital, c. 1900', source: 'https://commons.wikimedia.org/w/index.php?search=BECKENHAM+COTTAGE+HOSPITAL+postcard&title=Special:MediaSearch' },
  crystalPalace: { src: '/images/crystal-palace-1854.jpg', caption: 'The Crystal Palace from the Water Temple, 1854', source: 'https://commons.wikimedia.org/wiki/File:Crystal_Palace_General_view_from_Water_Temple.jpg' },
};
